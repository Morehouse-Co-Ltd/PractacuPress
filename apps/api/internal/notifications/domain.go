// Package notifications owns in-app notifications: what may be sent, to whom, and how
// read state changes.
//
// A notification is always addressed to exactly one user. There is deliberately no
// broadcast type: fan-out is written as one row per recipient so the read state and the
// listing query stay per user (review P0-2).
package notifications

import (
	"errors"
	"fmt"
	"time"
)

// Type is the kind of notification.
type Type string

// Supported notification types.
const (
	TypeComment  Type = "comment.created"
	TypeReaction Type = "reaction.created"
	TypeFollow   Type = "follow.created"
	TypeMessage  Type = "message.created"
	// TypeMessageDirect is the direct message inbox row contract B asks for.
	//
	// The wire value is "message.created", the same string the live push event uses:
	// the dashboard already has a renderer for it, and two spellings of the same event
	// would show an unrendered row to the recipient. The row lives in the notification
	// table, the push event lives in the outbox, so sharing the type name is safe.
	TypeMessageDirect Type = "message.created"
	TypeModeration    Type = "moderation.updated"
	// TypeContact is the public contact form: an anonymous visitor's message to the
	// site administrators. It has no actor and no subject row.
	TypeContact Type = "contact.created"
)

// Valid reports whether the type is defined.
func (t Type) Valid() bool {
	switch t {
	case TypeComment, TypeReaction, TypeFollow, TypeMessage, TypeModeration, TypeContact:
		return true
	default:
		return false
	}
}

// Sentinel errors.
var (
	// ErrInvalidInput means a field failed validation.
	ErrInvalidInput = errors.New("notifications: invalid input")
	// ErrNotFound means the notification does not exist for this user.
	ErrNotFound = errors.New("notifications: not found")
	// ErrPermissionDenied means the caller is not the recipient.
	ErrPermissionDenied = errors.New("notifications: permission denied")
	// ErrCrossSite means the notification belongs to another site.
	ErrCrossSite = errors.New("notifications: cross site access")
	// ErrSelfNotification means the actor would notify itself.
	ErrSelfNotification = errors.New("notifications: cannot notify yourself")
)

// Bounds.
const (
	// MaxPayloadKeys bounds a payload object.
	MaxPayloadKeys = 20
	// MaxPayloadValueLength bounds one payload string value.
	MaxPayloadValueLength = 200
	// MaxDedupeKeyLength matches the notification column. A producer builds it
	// from ids, so anything longer is a bug rather than user input.
	MaxDedupeKeyLength = 120
)

// Notification is one message for one user.
type Notification struct {
	ID        string
	SiteID    string
	UserID    string
	Type      Type
	ActorID   string
	SubjectID string
	Payload   map[string]string
	// DedupeKey is the producer supplied collapse key, when there is one.
	DedupeKey string
	ReadAt    *time.Time
	CreatedAt time.Time
}

// IsRead reports whether the recipient has seen it.
func (n Notification) IsRead() bool { return n.ReadAt != nil }

// NewInput is a create request.
type NewInput struct {
	SiteID    string
	UserID    string
	Type      Type
	ActorID   string
	SubjectID string
	Payload   map[string]string
	// DedupeKey, when set, collapses a repeat of the same interaction inside
	// DedupeWindow. Producers use it for toggleable interactions (a like, a
	// follow); a comment leaves it empty because every comment is a new event.
	DedupeKey string
	// DedupeWindow overrides the package DedupeWindow for this producer. Zero means
	// the default. The message fan-out uses a 10 minute window (contract B), because
	// a conversation becomes a new event again after a longer pause.
	DedupeWindow time.Duration
}

// Validate checks a create request.
//
// The payload is a flat string map with bounded size on purpose: it is stored as JSON
// and never queried, so a nested or unbounded value would only be a way to store
// arbitrary blobs in the notification table.
func Validate(in NewInput) (NewInput, error) {
	if in.SiteID == "" {
		return NewInput{}, fmt.Errorf("%w: site is required", ErrInvalidInput)
	}
	if in.UserID == "" {
		return NewInput{}, fmt.Errorf("%w: recipient is required", ErrInvalidInput)
	}
	if !in.Type.Valid() {
		return NewInput{}, fmt.Errorf("%w: unknown type", ErrInvalidInput)
	}
	if in.ActorID != "" && in.ActorID == in.UserID {
		return NewInput{}, ErrSelfNotification
	}
	if len(in.Payload) > MaxPayloadKeys {
		return NewInput{}, fmt.Errorf("%w: payload has too many keys", ErrInvalidInput)
	}
	if len(in.DedupeKey) > MaxDedupeKeyLength {
		return NewInput{}, fmt.Errorf("%w: dedupe key is too long", ErrInvalidInput)
	}
	if in.DedupeWindow < 0 {
		return NewInput{}, fmt.Errorf("%w: dedupe window must not be negative", ErrInvalidInput)
	}
	for key, value := range in.Payload {
		if len(key) > 40 {
			return NewInput{}, fmt.Errorf("%w: payload key is too long", ErrInvalidInput)
		}
		if len(value) > payloadValueLimit(in.Type, key) {
			return NewInput{}, fmt.Errorf("%w: payload value is too long", ErrInvalidInput)
		}
	}
	return in, nil
}

// payloadValueLimit is the byte ceiling of one payload value.
//
// Every type uses MaxPayloadValueLength; the contact form is the single exception, and
// only for the key that carries the reader's message (see contact.go for why).
func payloadValueLimit(t Type, key string) int {
	if t == TypeContact && key == "message" {
		return maxContactMessageBytes
	}
	return MaxPayloadValueLength
}

// CanMarkRead reports whether the actor may change read state.
//
// Only the recipient may, and only for a notification on the actor's own site: an
// administrator cannot mark someone else's notification read.
func (n Notification) CanMarkRead(userID, siteID string) error {
	if n.SiteID != siteID {
		return ErrCrossSite
	}
	if n.UserID != userID {
		return ErrPermissionDenied
	}
	return nil
}

// MarkRead returns the notification with its read timestamp set.
//
// Marking an already read notification returns it unchanged: the endpoint must be safe
// to retry, and the first read timestamp is the one that matters for analytics.
func (n Notification) MarkRead(userID, siteID string, at time.Time) (Notification, bool, error) {
	if err := n.CanMarkRead(userID, siteID); err != nil {
		return Notification{}, false, err
	}
	if n.IsRead() {
		return n, false, nil
	}

	updated := n
	stamp := at
	updated.ReadAt = &stamp
	return updated, true, nil
}
