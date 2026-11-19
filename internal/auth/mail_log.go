package auth

import (
	"context"
	"strings"

	"github.com/practacu/practacu-press/internal/platform/mailer"
)

// Mail log values. The strings are the generated email_logs schema values, the same
// ones the newsletter module writes, so the dashboard can show system mail and
// campaigns in one view.
const (
	// MailLogKindSystem marks mail the software itself triggers: a reset link, a
	// verification link. Auth never sends anything else.
	MailLogKindSystem = "system"
)

// MailLogTemplatePasswordReset and MailLogTemplateEmailVerify name the flow that
// produced a message.
//
// They are pinned literals on purpose instead of being derived from the verification
// token kinds: the token kind is persistence metadata for one table, while this is a
// dashboard filter key, and a rename of the former must not silently rewrite history
// in the mail log.
const (
	MailLogTemplatePasswordReset = "password_reset"
	MailLogTemplateEmailVerify   = "email_verify"
)

// MailLogMaxErrorLength bounds the failure reason stored in email_logs.error. The
// column is 500 bytes, so a chatty SMTP server cannot grow the row without bound. It
// mirrors the email gateway's own limit, which keeps system and newsletter rows
// comparable.
const MailLogMaxErrorLength = 500

// mailLogReasonNoRelay is recorded on the skipped rows this package writes: the
// attempt existed, but this deployment has no SMTP relay to deliver it.
const mailLogReasonNoRelay = "smtp is not configured"

// MailLogEntry is the email_logs row that exists before a delivery attempt.
//
// The fields mirror the columns such a row needs. The outcome columns are written by
// the Mark* methods instead (status, error, provider_message_id, sent_at), and
// subscriber_id stays empty because auth mail is never addressed to a newsletter
// subscriber. Not every field is required: mail the software cannot attribute to a
// site carries an empty SiteID rather than a fabricated one.
type MailLogEntry struct {
	SiteID      string
	ToEmail     string
	Kind        string
	TemplateKey string
	Subject     string
}

// MailLog is the narrow port to the installation's shared mail log (email_logs).
//
// It is deliberately tiny and declared here rather than imported from the newsletter
// module: auth only needs to say "a system mail attempt started and how it ended",
// and the composition root adapts the one store both modules write through.
//
// Record inserts the row in the queued state and returns its id, so a crash between
// the relay call and the update leaves a visibly stuck row instead of a message
// nobody can account for.
//
// A nil MailLog is valid and means "do not record": every send path then behaves
// exactly as it did before the mail log existed.
type MailLog interface {
	Record(ctx context.Context, entry MailLogEntry) (string, error)
	MarkSent(ctx context.Context, id, providerMessageID string) error
	MarkFailed(ctx context.Context, id, reason string) error
	MarkSkipped(ctx context.Context, id, reason string) error
}

// sendSystemMail delivers one transactional message and records the attempt in the
// mail log when one is wired.
//
// Bookkeeping is best effort throughout: Record/Mark failures become warnings and the
// mail is still delivered. The caller only ever sees the relay's error, because a
// logging outage must not stop a password reset from reaching a user.
func (s *Service) sendSystemMail(
	ctx context.Context,
	siteID, templateKey string,
	msg mailer.Message,
) error {
	if !s.mailReady() {
		// Every caller checks this first and records its own skipped row; the guard is
		// here so a future caller can never dereference a nil sender.
		return ErrMailNotConfigured
	}
	if s.mailLog == nil {
		// No log port: identical to the pre-mail-log behaviour.
		return s.mailer.Send(ctx, msg)
	}

	id, recordErr := s.mailLog.Record(ctx, MailLogEntry{
		SiteID:      siteID,
		ToEmail:     firstRecipient(msg),
		Kind:        MailLogKindSystem,
		TemplateKey: templateKey,
		Subject:     msg.Subject,
	})
	if recordErr != nil {
		// The message is still sent: losing the log must never lose the mail.
		s.logWarn("mail log: record queued system mail failed",
			"error", recordErr, "template_key", templateKey, "site_id", siteID)
		id = ""
	}

	sendErr := s.mailer.Send(ctx, msg)
	if id == "" {
		return sendErr
	}

	if sendErr != nil {
		reason := truncateMailLogReason(sendErr.Error())
		if markErr := s.mailLog.MarkFailed(ctx, id, reason); markErr != nil {
			s.logWarn("mail log: mark system mail failed", "error", markErr, "log_id", id)
		}
		return sendErr
	}

	if markErr := s.mailLog.MarkSent(ctx, id, mailProviderMessageID(s.mailer)); markErr != nil {
		// The relay accepted the message; a bookkeeping failure must not turn a
		// delivered mail into a failed one.
		s.logWarn("mail log: mark system mail sent", "error", markErr, "log_id", id)
	}
	return nil
}

// recordSkippedSystemMail writes the row for an attempt that never reached the relay
// because this deployment has no SMTP relay configured.
//
// This is what lets the dashboard answer "why was no mail sent" instead of looking
// empty. Like the delivery path it is best effort: a log failure is a warning, never
// an error for the caller. An empty recipient is dropped because email_logs.to_email
// is mandatory, so there is nothing honest to write.
func (s *Service) recordSkippedSystemMail(
	ctx context.Context,
	siteID, templateKey, to, subject, reason string,
) {
	if s.mailLog == nil {
		return
	}
	to = strings.TrimSpace(to)
	if to == "" {
		return
	}

	id, err := s.mailLog.Record(ctx, MailLogEntry{
		SiteID:      siteID,
		ToEmail:     to,
		Kind:        MailLogKindSystem,
		TemplateKey: templateKey,
		Subject:     subject,
	})
	if err != nil {
		s.logWarn("mail log: record skipped system mail failed",
			"error", err, "template_key", templateKey, "site_id", siteID)
		return
	}
	if err := s.mailLog.MarkSkipped(ctx, id, reason); err != nil {
		s.logWarn("mail log: mark system mail skipped", "error", err, "log_id", id)
	}
}

// firstRecipient is the address a log row records: auth mail always has exactly one.
func firstRecipient(msg mailer.Message) string {
	if len(msg.To) == 0 {
		return ""
	}
	return strings.TrimSpace(msg.To[0])
}

// truncateMailLogReason bounds what is stored in email_logs.error. It counts bytes
// like the column limit does; cutting a multi byte rune only affects the tail.
func truncateMailLogReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if len(reason) <= MailLogMaxErrorLength {
		return reason
	}
	return reason[:MailLogMaxErrorLength]
}

// mailMessageIDReporter is the optional extension of mailer.Sender for relays whose
// message id the sender exposes. It mirrors the email gateway's own probe, so a
// system row and a newsletter row carry the same provider_message_id.
type mailMessageIDReporter interface {
	LastMessageID() string
}

// mailProviderMessageID returns the provider's id for the message just accepted. The
// shipped SMTP sender cannot report one, and the column then stays empty.
func mailProviderMessageID(sender mailer.Sender) string {
	reporter, ok := sender.(mailMessageIDReporter)
	if !ok {
		return ""
	}
	id := strings.TrimSpace(reporter.LastMessageID())
	if len(id) > 200 {
		id = id[:200]
	}
	return id
}
