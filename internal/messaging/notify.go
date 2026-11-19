package messaging

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/notifications"
)

// Direct message notification fan-out (contract B).
//
// The producer lives here, next to the write that causes it, instead of in the
// transport: every caller of Send gets the inbox rows, and the notification is
// written after the message and its read cursor are committed. It is still one
// service call chain, which is what "not in the handler" means in the contract.
//
// The rows are written one per recipient by notifications.Service.Notify. That is
// deliberate: the notifications module owns payload validation, channel
// preferences, email decisions and the live push, and re-implementing any of that
// here would drift. The trade-off is that the fan-out is not part of the message
// transaction; a notification outage therefore never rolls a message back, and a
// missed row is recovered by the message itself, which the recipient still sees.

// MessageNotifyWindow is the dedupe window of a message notification: a second
// message inside ten minutes updates nothing, a later one notifies again (contract B).
const MessageNotifyWindow = 10 * time.Minute

// messageExcerptRunes bounds how much of the message body is copied into the inbox
// payload. The payload column is small and the excerpt is only a teaser.
const messageExcerptRunes = 80

// Notifier creates one inbox notification.
//
// It mirrors notifications.Service.Notify so the composition root can pass that
// service directly; the messaging module does not depend on the rest of it.
type Notifier interface {
	Notify(ctx context.Context, in notifications.NewInput) (notifications.Notification, error)
}

// WithNotifier installs the notification producer used by Send.
//
// Without it the fan-out is skipped, which keeps the pre-contract behaviour for
// callers that do not model notifications (tests, single process tools).
func WithNotifier(notifier Notifier) ServiceOption {
	return func(s *Service) {
		if notifier != nil {
			s.notifier = notifier
		}
	}
}

// WithLogger installs the logger used for best effort fan-out failures.
func WithLogger(logger *slog.Logger) ServiceOption {
	return func(s *Service) {
		if logger != nil {
			s.logger = logger
		}
	}
}

// notifyMessage writes one inbox notification per recipient of a new message.
//
// The sender is skipped (nobody needs to be told about their own message), and a
// recipient that is no longer an active member of the site is skipped when the
// membership checker is wired: a suspended account must not accumulate messages it
// cannot read.
func (s *Service) notifyMessage(ctx context.Context, conversation Conversation, message Message) {
	if s.notifier == nil {
		return
	}

	payload := map[string]string{
		"title":           messageNotificationTitle(conversation.Kind),
		"excerpt":         messageExcerpt(message.Body),
		"conversation_id": conversation.ID,
	}

	for _, member := range conversation.Members {
		if member.UserID == "" || member.UserID == message.SenderID {
			continue
		}
		if !s.messageRecipientActive(ctx, conversation.SiteID, member.UserID) {
			continue
		}
		_, err := s.notifier.Notify(ctx, notifications.NewInput{
			SiteID:    conversation.SiteID,
			UserID:    member.UserID,
			Type:      notifications.TypeMessageDirect,
			ActorID:   message.SenderID,
			SubjectID: conversation.ID,
			Payload:   payload,
			DedupeKey: messageDedupeKey(conversation.ID, member.UserID),
			// Contract B: a repeated message inside ten minutes does not add a row.
			DedupeWindow: MessageNotifyWindow,
		})
		if err != nil {
			s.logError("message notification fan-out failed",
				"error", err,
				"conversation_id", conversation.ID,
				"user_id", member.UserID,
			)
		}
	}
}

// messageRecipientActive reports whether a recipient may still receive messages.
//
// A checker failure is treated as active: the message was committed and the
// notification is best effort, so an outage in the membership read must not silently
// drop the inbox row for everyone.
func (s *Service) messageRecipientActive(ctx context.Context, siteID, userID string) bool {
	if s.members == nil {
		return true
	}
	active, err := s.members.IsActiveMember(ctx, siteID, userID)
	if err != nil {
		s.logError("check message recipient membership failed",
			"error", err, "site_id", siteID, "user_id", userID)
		return true
	}
	return active
}

// messageDedupeKey is the contract B collapse key.
func messageDedupeKey(conversationID, userID string) string {
	return "message:" + conversationID + ":" + userID
}

// messageNotificationTitle is the human label the inbox shows for this thread kind.
//
// Conversations carry no title of their own, so the kind is the best stable label;
// the excerpt and the actor name carry the rest of the context.
func messageNotificationTitle(kind ConversationKind) string {
	if kind == KindGroup {
		return "群聊"
	}
	return "私信"
}

// messageExcerpt renders a one line preview of a message body.
//
// Newlines are folded to spaces (the inbox renders one line) and the result is cut
// on a rune boundary to the notification payload bounds, so a long or CJK body
// cannot fail validation in the notifications module. The cut is marked with an
// ellipsis, which is why the byte budget reserves room for it.
func messageExcerpt(body string) string {
	text := strings.Join(strings.Fields(body), " ")
	if text == "" {
		return ""
	}
	if runes := []rune(text); len(runes) > messageExcerptRunes {
		text = string(runes[:messageExcerptRunes])
	}
	limit := notifications.MaxPayloadValueLength
	if len(text) <= limit {
		return text
	}

	// Reserve the ellipsis so the final value still fits the column bound.
	budget := limit - len("…")
	cut := 0
	for index := range text {
		if index > budget {
			break
		}
		cut = index
	}
	if cut == 0 {
		return ""
	}
	return text[:cut] + "…"
}

// logError records a best effort failure when a logger was wired.
func (s *Service) logError(msg string, args ...any) {
	if s.logger != nil {
		s.logger.Error(msg, args...)
	}
}
