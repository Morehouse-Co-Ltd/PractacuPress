package notifications

import (
	"context"
	"errors"
	"strings"

	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
)

// Mail log values. The strings are the generated email_logs schema values, the same
// ones the newsletter module writes, so one dashboard view covers system mail and
// campaigns together.
const (
	// MailLogKindSystem marks mail the software itself triggers. A notification is
	// always system mail: it is never a campaign an operator sent on purpose.
	MailLogKindSystem = "system"
	// MailLogTemplateNotification is the template key of every notification mail: the
	// body is rendered from a notification type rather than a stored template.
	MailLogTemplateNotification = "notification"
)

// MailLogMaxErrorLength bounds the failure reason stored in email_logs.error. The
// column is 500 bytes. It mirrors the email gateway's own limit, which keeps system
// and newsletter rows comparable.
const MailLogMaxErrorLength = 500

// mailLogReasonNoRelay is recorded on the skipped rows this package writes: the
// notification exists, but this deployment has no SMTP relay to deliver it.
const mailLogReasonNoRelay = "smtp is not configured"

// MailLogEntry is the email_logs row that exists before a delivery attempt.
//
// The fields mirror the columns such a row needs. The outcome columns are written by
// the Mark* methods instead (status, error, provider_message_id, sent_at), and
// subscriber_id stays empty because a notification goes to a site account, not to a
// newsletter list entry.
type MailLogEntry struct {
	SiteID      string
	ToEmail     string
	Kind        string
	TemplateKey string
	Subject     string
}

// MailLog is the narrow port to the installation's shared mail log (email_logs).
//
// It is declared here instead of imported from the newsletter module: notifications
// only need to report "a notification mail attempt started and how it ended", and the
// composition root adapts the one store both modules write through.
//
// Record inserts the row in the queued state and returns its id.
//
// A nil MailLog is valid and means "do not record": notification email is then
// delivered exactly as it was before the mail log existed.
type MailLog interface {
	Record(ctx context.Context, entry MailLogEntry) (string, error)
	MarkSent(ctx context.Context, id, providerMessageID string) error
	MarkFailed(ctx context.Context, id, reason string) error
	MarkSkipped(ctx context.Context, id, reason string) error
}

// errMailNotConfigured guards the send helper. The caller decides what a missing relay
// means (it records a skipped row and reports success), so this error is a programming
// guard rather than a user facing failure.
var errMailNotConfigured = errors.New("notifications: mail is not configured")

// sendSystemMail delivers one notification message and records the attempt in the
// mail log when one is wired.
//
// Bookkeeping is best effort: a failing Record/Mark becomes a warning and the mail is
// still delivered, because an observability outage must not drop a notification.
func (s *Service) sendSystemMail(
	ctx context.Context,
	siteID, templateKey string,
	msg mailer.Message,
) error {
	if !s.mailReady() {
		return errMailNotConfigured
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
		s.logWarn("mail log: record queued notification mail failed",
			"error", recordErr, "site_id", siteID)
		id = ""
	}

	sendErr := s.mailer.Send(ctx, msg)
	if id == "" {
		return sendErr
	}

	if sendErr != nil {
		reason := truncateMailLogReason(sendErr.Error())
		if markErr := s.mailLog.MarkFailed(ctx, id, reason); markErr != nil {
			s.logWarn("mail log: mark notification mail failed", "error", markErr, "log_id", id)
		}
		return sendErr
	}

	if markErr := s.mailLog.MarkSent(ctx, id, mailProviderMessageID(s.mailer)); markErr != nil {
		s.logWarn("mail log: mark notification mail sent", "error", markErr, "log_id", id)
	}
	return nil
}

// recordSkippedSystemMail writes the row for a notification mail that was never
// attempted because the deployment has no relay configured.
//
// This is what lets the dashboard answer "why was no mail sent" instead of looking
// empty. Best effort like the delivery path: a log failure is a warning, and an empty
// recipient is dropped because email_logs.to_email is mandatory.
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
		s.logWarn("mail log: record skipped notification mail failed",
			"error", err, "site_id", siteID)
		return
	}
	if err := s.mailLog.MarkSkipped(ctx, id, reason); err != nil {
		s.logWarn("mail log: mark notification mail skipped", "error", err, "log_id", id)
	}
}

// firstRecipient is the address a log row records: a notification mail has one.
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
// notification row and a newsletter row carry the same provider_message_id.
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
