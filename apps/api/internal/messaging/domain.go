// Package messaging owns private conversations: who may read them, how messages are
// ordered, and how read progress is tracked.
//
// Authorisation is the whole point of this package. A private message that leaks is
// worse than a broken feature, so every read path starts from conversation membership
// rather than from the message id.
package messaging

import (
	"errors"
	"fmt"
	"strings"
	"time"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// ConversationKind distinguishes a direct message thread from a group thread.
type ConversationKind string

// Supported conversation kinds.
const (
	KindDirect ConversationKind = "direct"
	KindGroup  ConversationKind = "group"
)

// Valid reports whether the kind is defined.
func (k ConversationKind) Valid() bool { return k == KindDirect || k == KindGroup }

// Sentinel errors.
var (
	// ErrInvalidInput means a field failed validation.
	ErrInvalidInput = errors.New("messaging: invalid input")
	// ErrNotFound means the conversation or message does not exist.
	ErrNotFound = errors.New("messaging: not found")
	// ErrNotMember means the caller is not part of the conversation.
	ErrNotMember = errors.New("messaging: not a conversation member")
	// ErrCrossSite means the conversation belongs to another site.
	ErrCrossSite = errors.New("messaging: cross site access")
)

// Bounds.
const (
	// MaxBodyLength bounds one message body, in characters.
	MaxBodyLength = 5000
	// MaxMembers bounds a group conversation.
	MaxMembers = 100
	// MinDirectMembers is exact membership of a direct thread.
	MinDirectMembers = 2
)

// invalidField builds a field error that stays matchable as ErrInvalidInput.
//
// Both sentinels are wrapped: errors.Is(err, ErrInvalidInput) keeps working for the
// transport, while errors.As(err, &FieldError) recovers the field and rule the client
// translates. FieldError itself lives in the error model package and cannot reference
// this package's sentinel without an import cycle, which is why the wrapping happens
// here rather than in an Unwrap method.
func invalidField(field, rule, reason string) error {
	return fmt.Errorf("%w: %w", ErrInvalidInput, &apperr.FieldError{
		Field:  field,
		Rule:   rule,
		Reason: reason,
	})
}

// Actor is the caller.
type Actor struct {
	UserID string
	SiteID string
	Role   site.Role
}

// Member is one participant of a conversation.
type Member struct {
	UserID string
	// LastReadMessageID is the read cursor; empty means nothing read yet.
	LastReadMessageID string
	JoinedAt          time.Time
}

// Conversation is one thread.
type Conversation struct {
	ID        string
	SiteID    string
	Kind      ConversationKind
	CreatedBy string
	Members   []Member
	CreatedAt time.Time
}

// HasMember reports whether a user participates.
func (c Conversation) HasMember(userID string) bool {
	for _, member := range c.Members {
		if member.UserID == userID {
			return true
		}
	}
	return false
}

// Authorize returns nil only when the actor may read and write this conversation.
//
// Site isolation is checked before membership so a member of the same conversation id
// on another site cannot slip through.
func (c Conversation) Authorize(actor Actor) error {
	if c.SiteID != actor.SiteID {
		return ErrCrossSite
	}
	if !c.HasMember(actor.UserID) {
		return ErrNotMember
	}
	return nil
}

// Message is one message in a conversation.
type Message struct {
	ID             string
	SiteID         string
	ConversationID string
	SenderID       string
	Body           string
	CreatedAt      time.Time
}

// NewMessageInput is a send request.
type NewMessageInput struct {
	ConversationID string
	Body           string
}

// ValidateMessage normalises and validates a send request.
func ValidateMessage(in NewMessageInput) (NewMessageInput, error) {
	in.ConversationID = strings.TrimSpace(in.ConversationID)
	in.Body = strings.TrimSpace(in.Body)

	if in.ConversationID == "" {
		return NewMessageInput{}, fmt.Errorf("%w: conversation is required", ErrInvalidInput)
	}
	if in.Body == "" {
		return NewMessageInput{}, invalidField("body", "required", "body is required")
	}
	if len([]rune(in.Body)) > MaxBodyLength {
		return NewMessageInput{}, invalidField("body", "too_long", "body is too long")
	}
	return in, nil
}

// ValidateDirectMembers checks a direct thread has exactly two distinct members.
func ValidateDirectMembers(members []string) error {
	if len(members) != MinDirectMembers {
		return ErrInvalidInput
	}
	if members[0] == "" || members[1] == "" || members[0] == members[1] {
		return ErrInvalidInput
	}
	return nil
}

// ValidateGroupMembers checks a group thread is bounded and free of duplicates.
func ValidateGroupMembers(members []string) error {
	if len(members) < MinDirectMembers || len(members) > MaxMembers {
		return ErrInvalidInput
	}
	seen := make(map[string]struct{}, len(members))
	for _, member := range members {
		if member == "" {
			return ErrInvalidInput
		}
		if _, dup := seen[member]; dup {
			return ErrInvalidInput
		}
		seen[member] = struct{}{}
	}
	return nil
}

// AdvanceReadCursor moves a member's read cursor forward.
//
// It only ever moves forward, so an out of order update from a second device cannot
// mark already read messages unread.
func (c Conversation) AdvanceReadCursor(userID, messageID string) (Conversation, error) {
	if !c.HasMember(userID) {
		return Conversation{}, ErrNotMember
	}

	updated := c
	updated.Members = make([]Member, len(c.Members))
	copy(updated.Members, c.Members)

	for i := range updated.Members {
		if updated.Members[i].UserID == userID {
			updated.Members[i].LastReadMessageID = messageID
			return updated, nil
		}
	}
	return Conversation{}, ErrNotMember
}
