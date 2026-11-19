// Package newsletter owns the mailing list and the transactional mail templates.
//
// Two flows live here: the public double opt in subscription (an address only joins
// the list after the owner clicks the confirmation link) and the newsletter queue
// (an operator queues one delivery per confirmed subscriber, a background sender
// drains it through the platform email gateway). Every token that reaches a URL in a
// mail is stored as a SHA-256 hash; the plaintext exists only inside the message that
// was sent, so a database dump cannot be replayed as a confirmation or unsubscribe
// link.
package newsletter

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/mail"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/platform/emailgateway"
	"github.com/practacu/practacu-press/internal/platform/mailer"
	"github.com/practacu/practacu-press/internal/platform/page"
)

// Subscriber statuses. They mirror the generated subscriber schema values.
const (
	StatusPending      = "pending"
	StatusConfirmed    = "confirmed"
	StatusUnsubscribed = "unsubscribed"
	StatusBounced      = "bounced"
)

// Subscription sources recorded on the subscriber row.
const (
	// SourceSite is the public footer form; no account is required.
	SourceSite = "site"
	// SourceAccount is the "subscribe me" switch on the account page.
	SourceAccount = "account"
)

// Limits shared by the service and the HTTP layer.
const (
	// MaxEmailLength matches the generated column.
	MaxEmailLength = 320
	// MaxSourceLength bounds the free form source label.
	MaxSourceLength = 40
	// MaxSubjectLength matches the email_logs and email_templates columns.
	MaxSubjectLength = 300
	// MaxTemplateNameLength matches the email_templates column.
	MaxTemplateNameLength = 120
	// MaxTemplateBodyBytes bounds one stored template body. The value is generous
	// for an HTML mail but small enough that a single write cannot fill storage.
	MaxTemplateBodyBytes = 256 << 10
	// MaxPageSize is the largest page a list endpoint returns.
	MaxPageSize = 100
	// DefaultPageSize is the page size when the client does not ask for one.
	DefaultPageSize = 20
)

// Errors the service reports. The HTTP layer maps them onto Problem codes.
var (
	// ErrInvalidEmail means the address is not a syntactically usable mailbox.
	ErrInvalidEmail = errors.New("newsletter: invalid email address")
	// ErrInvalidSource means the source label is too long.
	ErrInvalidSource = errors.New("newsletter: invalid source")
	// ErrNotFound means no subscriber, template, log or site matched.
	ErrNotFound = errors.New("newsletter: not found")
	// ErrInvalidToken means the confirmation or unsubscribe token did not resolve.
	ErrInvalidToken = errors.New("newsletter: invalid token")
	// ErrRateLimited means the caller exceeded the subscribe budget for its IP.
	ErrRateLimited = errors.New("newsletter: rate limited")
	// ErrInvalidTemplate means a template failed validation.
	ErrInvalidTemplate = errors.New("newsletter: invalid email template")
	// ErrInvalidFilter means a list filter carried a value outside the documented
	// enum.
	ErrInvalidFilter = errors.New("newsletter: invalid filter")
	// ErrTemplateNotFound means an override for the requested key does not exist.
	ErrTemplateNotFound = errors.New("newsletter: email template not found")
	// ErrContentNotFound means the content id of a newsletter does not resolve.
	ErrContentNotFound = errors.New("newsletter: content not found")
	// ErrAccountEmailMissing means the signed in account has no email identity.
	ErrAccountEmailMissing = errors.New("newsletter: account has no email address")
)

// Subscriber is one mailing list entry.
type Subscriber struct {
	ID             string
	SiteID         string
	Email          string
	Status         string
	Source         string
	UserID         string
	ConfirmedAt    *time.Time
	UnsubscribedAt *time.Time
	LastSentAt     *time.Time
	CreatedAt      time.Time
	// TokenHash is the SHA-256 hash of the token named in the last mail this
	// subscriber received. The plaintext token is never persisted.
	TokenHash string
}

// EmailLog is one outbound delivery.
type EmailLog struct {
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

// EmailTemplate is one rendered message definition.
//
// Builtin templates come from code; a row in the database overrides one of them for
// a site. Campaign templates (the body of a queued newsletter) are stored as
// overrides too, under an internal key that the editor never lists.
type EmailTemplate struct {
	// SiteID scopes a stored override. It is empty for a built in default.
	SiteID    string
	Key       string
	Name      string
	Subject   string
	BodyHTML  string
	BodyText  string
	Enabled   bool
	Builtin   bool
	UpdatedAt *time.Time
}

// SiteInfo is the site metadata templates need.
type SiteInfo struct {
	ID     string
	Name   string
	Domain string
}

// SubscriberFilter narrows an admin subscriber list.
type SubscriberFilter struct {
	// Status keeps one state; empty keeps every state.
	Status string
	// Query matches the address, case insensitively.
	Query string
}

// EmailLogFilter narrows an admin mail log list.
type EmailLogFilter struct {
	Status string
	Kind   string
}

// SubscriberCounts is the part of the stats endpoint that counts the list.
type SubscriberCounts struct {
	Confirmed    int
	Pending      int
	Unsubscribed int
	Bounced      int
}

// EmailLogCounts is the delivery count of the stats endpoint.
type EmailLogCounts struct {
	Sent   int
	Failed int
}

// Stats is the dashboard payload.
type Stats struct {
	Confirmed    int
	Pending      int
	Unsubscribed int
	Sent7d       int
	Failed7d     int
}

// MyPreference is the signed in account's newsletter switch.
type MyPreference struct {
	Subscribed bool
	Email      string
	Status     string
}

// ContentDigest renders a content item into the newsletter body.
//
// It is an interface because the content module owns that data and this module only
// needs three strings. The composition root injects the implementation; a nil
// digest means content backed newsletters are rejected as not found.
type ContentDigest interface {
	Digest(ctx context.Context, siteID, contentID string) (title, summary, url string, ok bool, err error)
}

// EmailGateway is the delivery port. *emailgateway.Gateway implements it.
type EmailGateway interface {
	// Configured reports whether a relay exists.
	Configured() bool
	// Send writes a queued log row and attempts delivery.
	Send(ctx context.Context, req emailgateway.Request) error
	// Deliver attempts delivery of a row that already exists, which is what the
	// newsletter queue uses.
	Deliver(ctx context.Context, logID string, msg mailer.Message) (emailgateway.Outcome, error)
}

// Repository is the persistence port of the newsletter module.
//
// It embeds the gateway's log port because one Ent store implements both, and the
// queue shares the same email_logs table.
type Repository interface {
	emailgateway.Store

	// FindSubscriberByEmail resolves one site's list entry by address.
	FindSubscriberByEmail(ctx context.Context, siteID, email string) (Subscriber, error)
	// FindSubscriberByTokenHash resolves a confirmation/unsubscribe token.
	FindSubscriberByTokenHash(ctx context.Context, tokenHash string) (Subscriber, error)
	// FindSubscriberByID resolves one row inside a site.
	FindSubscriberByID(ctx context.Context, siteID, id string) (Subscriber, error)
	// SaveSubscriber inserts an entry when ID is empty and replaces the stored
	// fields otherwise.
	SaveSubscriber(ctx context.Context, subscriber Subscriber) (Subscriber, error)
	// ListSubscribers returns one newest first page plus the next cursor.
	ListSubscribers(
		ctx context.Context,
		siteID string,
		filter SubscriberFilter,
		limit int,
		after page.Cursor,
	) ([]Subscriber, string, error)
	// ListConfirmedSubscribers returns every confirmed entry of a site, which is
	// the recipient set of one newsletter.
	ListConfirmedSubscribers(ctx context.Context, siteID string) ([]Subscriber, error)
	// DeleteSubscriber removes one entry.
	DeleteSubscriber(ctx context.Context, siteID, id string) error
	// CountSubscribers returns the list counts of the stats endpoint.
	CountSubscribers(ctx context.Context, siteID string) (SubscriberCounts, error)
	// UpdateSubscriberLastSent stamps the row after a successful delivery.
	UpdateSubscriberLastSent(ctx context.Context, id string, at time.Time) error

	// GetEmailTemplate returns one site override.
	GetEmailTemplate(ctx context.Context, siteID, key string) (EmailTemplate, bool, error)
	// ListEmailTemplates returns every override of a site.
	ListEmailTemplates(ctx context.Context, siteID string) ([]EmailTemplate, error)
	// SaveEmailTemplate upserts one override.
	SaveEmailTemplate(ctx context.Context, template EmailTemplate) (EmailTemplate, error)
	// DeleteEmailTemplate drops one override.
	DeleteEmailTemplate(ctx context.Context, siteID, key string) error
	// DeleteEmailTemplateIfUnqueued drops a campaign override once no queued
	// delivery references it any more.
	DeleteEmailTemplateIfUnqueued(ctx context.Context, siteID, key string) (bool, error)

	// InsertEmailLogs writes the queued campaign rows in one batch.
	InsertEmailLogs(ctx context.Context, entries []EmailLog) error
	// ListEmailLogs returns one newest first page plus the next cursor.
	ListEmailLogs(
		ctx context.Context,
		siteID string,
		filter EmailLogFilter,
		limit int,
		after page.Cursor,
	) ([]EmailLog, string, error)
	// ListQueuedNewsletterLogs returns the oldest queued campaign rows across the
	// deployment, which is what the background sender drains.
	ListQueuedNewsletterLogs(ctx context.Context, limit int) ([]EmailLog, error)
	// RequeueEmailLog puts a failed attempt back into the queue.
	RequeueEmailLog(ctx context.Context, id, reason string) error
	// FinalizeEmailLogFailure records the last failed attempt.
	FinalizeEmailLogFailure(ctx context.Context, id, reason string, at time.Time) error
	// CountEmailLogsSince counts deliveries in a time window for the stats card.
	CountEmailLogsSince(ctx context.Context, siteID string, since time.Time) (EmailLogCounts, error)

	// GetSiteInfo returns the site name templates render.
	GetSiteInfo(ctx context.Context, siteID string) (SiteInfo, error)
}

// NormalizeEmail lowercases and trims an address, then verifies it.
//
// Lowercasing is what makes the unique (site_id, email) index treat
// Alice@Example.com and alice@example.com as one subscription.
func NormalizeEmail(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > MaxEmailLength {
		return "", ErrInvalidEmail
	}
	address, err := mail.ParseAddress(trimmed)
	if err != nil || address.Address != trimmed {
		return "", ErrInvalidEmail
	}
	lowered := strings.ToLower(trimmed)
	if !strings.Contains(lowered, "@") {
		return "", ErrInvalidEmail
	}
	// The local part of an address cannot contain whitespace; ParseAddress already
	// enforces the RFC shape, and the length check above bounds the column.
	return lowered, nil
}

// NormalizeSource bounds the free form source label.
func NormalizeSource(raw string) (string, error) {
	source := strings.ToLower(strings.TrimSpace(raw))
	if len(source) > MaxSourceLength {
		return "", ErrInvalidSource
	}
	if source == "" {
		return SourceSite, nil
	}
	return source, nil
}

// NewToken returns a fresh URL safe token. 32 bytes of entropy make the link
// unguessable; base64url keeps it safe in a query string without escaping.
func NewToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

// HashToken returns the SHA-256 hash stored in subscriber.token_hash.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// HashIP hashes a caller address for the subscribe rate limiter.
//
// The HTTP layer hashes before calling the service, so the plaintext address never
// exists anywhere inside this package, not even in memory.
func HashIP(address string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(address)))
	return hex.EncodeToString(sum[:])
}

// tokenHashOf is HashToken for a token that may already be empty; an empty token
// hashes to a value that never matches a stored row, which is the safe direction.
func tokenHashOf(token string) string { return HashToken(strings.TrimSpace(token)) }
