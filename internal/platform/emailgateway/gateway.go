// Package emailgateway is the single outbound mail path of the installation.
//
// Every message that leaves the process goes through this package, which is what
// makes the dashboard's mail log trustworthy: before the SMTP client is touched a
// row is written to email_logs with status=queued, and the row is updated with the
// outcome afterwards. Callers hand in a rendered message; rendering is deliberately
// not this package's job (the newsletter module owns template rendering), so the
// gateway stays a delivery + bookkeeping layer.
//
// An installation without an SMTP relay still records every attempt as skipped and
// reports success. Mail is an optional capability: a caller that wants to know
// whether delivery is possible asks Configured, but a delivery call never fails
// just because the relay is missing. That rule exists because a subscription or a
// password reset must not be reported as broken when the operator simply has not
// configured mail yet.
package emailgateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/platform/mailer"
)

// Message kinds. They mirror the generated email_logs schema values.
const (
	// KindSystem is mail the software itself triggers (confirmation links,
	// verification codes, password resets).
	KindSystem = "system"
	// KindNewsletter is a campaign an operator sent on purpose.
	KindNewsletter = "newsletter"
)

// Delivery states. They mirror the generated email_logs schema values.
const (
	StatusQueued  = "queued"
	StatusSent    = "sent"
	StatusFailed  = "failed"
	StatusSkipped = "skipped"
)

// MaxErrorLength bounds the failure reason stored on a row.
//
// The column is 500 bytes; a chatty SMTP server must not be able to grow the row
// without bound, and the operator only needs the first line anyway.
const MaxErrorLength = 500

// Outcome reports what a delivery attempt did, so a caller can distinguish "sent"
// from "the relay is not configured but nothing is broken".
type Outcome string

// The delivery outcomes.
const (
	OutcomeSent    Outcome = "sent"
	OutcomeFailed  Outcome = "failed"
	OutcomeSkipped Outcome = "skipped"
)

// Request is one message to send and log.
//
// Subject/HTML/Text are already rendered. TemplateKey is recorded for the dashboard
// so the operator can tell which template produced the mail; it is not used for
// rendering here.
type Request struct {
	SiteID       string
	Kind         string
	TemplateKey  string
	To           string
	Subject      string
	HTML         string
	Text         string
	SubscriberID string
}

// Log is one email_logs row as the gateway sees it.
type Log struct {
	ID                string
	SiteID            string
	ToEmail           string
	Kind              string
	TemplateKey       string
	Subject           string
	Status            string
	Error             string
	ProviderMessageID string
	SubscriberID      string
	SentAt            *time.Time
	CreatedAt         time.Time
}

// Store is the persistence port behind the gateway.
//
// The newsletter queue layer implements it as well, because the queue writes and
// updates the same table; keeping one narrow interface here means the gateway does
// not depend on the newsletter module.
type Store interface {
	// InsertEmailLog writes the row that is created before a delivery attempt.
	InsertEmailLog(ctx context.Context, entry Log) (Log, error)
	// MarkEmailLogSent finalises a successful delivery.
	MarkEmailLogSent(ctx context.Context, id, providerMessageID string, at time.Time) error
	// MarkEmailLogFailed records a failed attempt. reason is truncated by the
	// gateway before it reaches the store.
	MarkEmailLogFailed(ctx context.Context, id, reason string, at time.Time) error
	// MarkEmailLogSkipped records an attempt that was not possible because no relay
	// is configured.
	MarkEmailLogSkipped(ctx context.Context, id string, at time.Time) error
}

// Option customises a Gateway.
type Option func(*Gateway)

// WithLogger installs the logger used for bookkeeping failures.
func WithLogger(logger *slog.Logger) Option {
	return func(g *Gateway) {
		if logger != nil {
			g.logger = logger
		}
	}
}

// WithClock replaces the clock. It exists so tests can assert stored timestamps.
func WithClock(now func() time.Time) Option {
	return func(g *Gateway) {
		if now != nil {
			g.now = now
		}
	}
}

// Gateway writes email_logs rows and delivers through mailer.Sender.
type Gateway struct {
	store  Store
	sender mailer.Sender
	logger *slog.Logger
	now    func() time.Time
}

// New builds a Gateway. A nil sender is the "SMTP is not configured" case: every
// delivery is recorded as skipped and reported as success.
func New(store Store, sender mailer.Sender, opts ...Option) *Gateway {
	g := &Gateway{
		store:  store,
		sender: sender,
		logger: slog.New(slog.DiscardHandler),
		now:    func() time.Time { return time.Now().UTC() },
	}
	for _, option := range opts {
		if option != nil {
			option(g)
		}
	}
	return g
}

// Configured reports whether a relay exists to deliver through.
func (g *Gateway) Configured() bool {
	return g != nil && g.sender != nil && g.sender.Configured()
}

// Send renders nothing: the caller hands over a finished message. It writes the
// queued row first, then attempts delivery and records the outcome.
//
// Validation failures are returned without writing a row: a message with no
// recipient or no subject is a programming error, not a delivery attempt.
func (g *Gateway) Send(ctx context.Context, req Request) error {
	if g == nil || g.store == nil {
		return errors.New("emailgateway: no log store configured")
	}
	to := strings.TrimSpace(req.To)
	if to == "" {
		return errors.New("emailgateway: recipient is required")
	}
	subject := strings.TrimSpace(req.Subject)
	if subject == "" {
		return errors.New("emailgateway: subject is required")
	}

	kind := normalizeKind(req.Kind)
	entry, err := g.store.InsertEmailLog(ctx, Log{
		SiteID:       req.SiteID,
		ToEmail:      to,
		Kind:         kind,
		TemplateKey:  truncate(req.TemplateKey, 80),
		Subject:      truncate(subject, 300),
		Status:       StatusQueued,
		SubscriberID: req.SubscriberID,
		CreatedAt:    g.now(),
	})
	if err != nil {
		return fmt.Errorf("emailgateway: record queued mail: %w", err)
	}

	_, err = g.Deliver(ctx, entry.ID, mailer.Message{
		To:      []string{to},
		Subject: subject,
		Text:    req.Text,
		HTML:    req.HTML,
	})
	return err
}

// Deliver sends a message whose email_logs row already exists.
//
// The newsletter queue creates its rows up front (one per confirmed subscriber) and
// the background sender drains them; reusing Send there would duplicate rows. The
// returned Outcome tells the caller whether the subscriber's last_sent_at should be
// touched.
func (g *Gateway) Deliver(ctx context.Context, logID string, msg mailer.Message) (Outcome, error) {
	if g == nil || g.store == nil {
		return OutcomeFailed, errors.New("emailgateway: no log store configured")
	}
	if strings.TrimSpace(logID) == "" {
		return OutcomeFailed, errors.New("emailgateway: log id is required")
	}

	if !g.Configured() {
		// No relay is not an error: record why nothing went out and let the caller
		// continue its own workflow.
		if err := g.store.MarkEmailLogSkipped(ctx, logID, g.now()); err != nil {
			return OutcomeSkipped, fmt.Errorf("emailgateway: record skipped mail: %w", err)
		}
		return OutcomeSkipped, nil
	}

	if err := g.sender.Send(ctx, msg); err != nil {
		reason := truncate(err.Error(), MaxErrorLength)
		if markErr := g.store.MarkEmailLogFailed(ctx, logID, reason, g.now()); markErr != nil {
			g.logger.Warn("emailgateway: record failed mail", "log_id", logID, "error", markErr)
		}
		return OutcomeFailed, fmt.Errorf("emailgateway: deliver: %w", err)
	}

	if err := g.store.MarkEmailLogSent(ctx, logID, providerMessageID(g.sender), g.now()); err != nil {
		// The relay accepted the message; a bookkeeping failure must not turn that
		// into a failed delivery, but it is worth surfacing to the caller.
		return OutcomeSent, fmt.Errorf("emailgateway: record sent mail: %w", err)
	}
	return OutcomeSent, nil
}

// messageIDReporter is the optional extension of mailer.Sender for relays whose
// message id the sender exposes.
//
// The shipped mailer.Sender only reports an error, so provider_message_id stays
// empty unless a sender implements this interface.
type messageIDReporter interface {
	LastMessageID() string
}

func providerMessageID(sender mailer.Sender) string {
	if reporter, ok := sender.(messageIDReporter); ok {
		return truncate(reporter.LastMessageID(), 200)
	}
	return ""
}

// normalizeKind keeps an unknown kind out of the database validator's way by
// falling back to the safe default: a mail without a campaign kind is system mail.
func normalizeKind(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case KindNewsletter:
		return KindNewsletter
	default:
		return KindSystem
	}
}

// truncate bounds a stored string. It counts bytes on purpose: the column limits are
// byte limits, and cutting in the middle of a multi byte rune only affects how the
// tail renders.
func truncate(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max]
}
