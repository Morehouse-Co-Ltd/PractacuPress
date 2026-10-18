package messaging

import (
	"context"
	"errors"
	"time"
)

// Repository is the persistence contract for messaging.
type Repository interface {
	// InsertConversation stores a conversation with its members atomically.
	InsertConversation(ctx context.Context, item Conversation) (Conversation, error)
	// FindConversation loads a conversation inside a site scope.
	FindConversation(ctx context.Context, siteID, conversationID string) (Conversation, error)
	// ListForUser returns the caller's conversations, newest activity first.
	ListForUser(ctx context.Context, siteID, userID string, limit int) ([]Conversation, error)
	// InsertMessage stores one message.
	InsertMessage(ctx context.Context, item Message) (Message, error)
	// ListMessages returns messages of a conversation in creation order.
	ListMessages(ctx context.Context, siteID, conversationID string, limit int) ([]Message, error)
	// AdvanceReadCursor moves a member's cursor and reports whether it changed.
	AdvanceReadCursor(ctx context.Context, siteID, conversationID, userID, messageID string) (bool, error)
}

// Bounds.
const (
	// DefaultConversationLimit is the conversation list page size.
	DefaultConversationLimit = 30
	// DefaultMessageLimit is the message page size.
	DefaultMessageLimit = 50
	// MaxPageLimit caps both lists.
	MaxPageLimit = 100
)

// Service implements conversations and private messages.
type Service struct {
	repo Repository
	now  func() time.Time
}

// NewService builds a Service.
func NewService(repo Repository) (*Service, error) {
	if repo == nil {
		return nil, errors.New("messaging: repository is required")
	}
	return &Service{repo: repo, now: func() time.Time { return time.Now().UTC() }}, nil
}

// StartConversation creates a thread.
//
// The caller is always a member: a conversation a user cannot read is not a useful
// thing to create, and requiring it removes a whole class of "created but invisible"
// bugs.
func (s *Service) StartConversation(
	ctx context.Context,
	actor Actor,
	kind ConversationKind,
	otherMembers []string,
) (Conversation, error) {
	if !kind.Valid() {
		return Conversation{}, ErrInvalidInput
	}

	members := append([]string{actor.UserID}, otherMembers...)
	if kind == KindDirect {
		if err := ValidateDirectMembers(members); err != nil {
			return Conversation{}, err
		}
	} else if err := ValidateGroupMembers(members); err != nil {
		return Conversation{}, err
	}

	now := s.now()
	memberRows := make([]Member, 0, len(members))
	for _, memberID := range members {
		memberRows = append(memberRows, Member{UserID: memberID, JoinedAt: now})
	}

	return s.repo.InsertConversation(ctx, Conversation{
		SiteID:    actor.SiteID,
		Kind:      kind,
		CreatedBy: actor.UserID,
		Members:   memberRows,
		CreatedAt: now,
	})
}

// List returns the caller's conversations.
func (s *Service) List(ctx context.Context, actor Actor, limit int) ([]Conversation, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return nil, ErrInvalidInput
	}
	if limit <= 0 || limit > MaxPageLimit {
		limit = DefaultConversationLimit
	}
	return s.repo.ListForUser(ctx, actor.SiteID, actor.UserID, limit)
}

// Messages returns the messages of a conversation the caller belongs to.
func (s *Service) Messages(
	ctx context.Context,
	actor Actor,
	conversationID string,
	limit int,
) ([]Message, error) {
	conversation, err := s.load(ctx, actor, conversationID)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > MaxPageLimit {
		limit = DefaultMessageLimit
	}
	return s.repo.ListMessages(ctx, conversation.SiteID, conversation.ID, limit)
}

// Send stores a message and advances the sender's read cursor.
func (s *Service) Send(
	ctx context.Context,
	actor Actor,
	in NewMessageInput,
) (Message, error) {
	validated, err := ValidateMessage(in)
	if err != nil {
		return Message{}, err
	}

	conversation, err := s.load(ctx, actor, validated.ConversationID)
	if err != nil {
		return Message{}, err
	}

	created, err := s.repo.InsertMessage(ctx, Message{
		SiteID:         conversation.SiteID,
		ConversationID: conversation.ID,
		SenderID:       actor.UserID,
		Body:           validated.Body,
		CreatedAt:      s.now(),
	})
	if err != nil {
		return Message{}, err
	}

	// Sending implies reading: leaving the sender's own message unread would make the
	// unread badge lie.
	if _, markErr := s.repo.AdvanceReadCursor(ctx, conversation.SiteID, conversation.ID,
		actor.UserID, created.ID); markErr != nil {
		return Message{}, markErr
	}
	return created, nil
}

// MarkRead advances the caller's read cursor.
func (s *Service) MarkRead(
	ctx context.Context,
	actor Actor,
	conversationID, messageID string,
) (bool, error) {
	conversation, err := s.load(ctx, actor, conversationID)
	if err != nil {
		return false, err
	}
	return s.repo.AdvanceReadCursor(ctx, conversation.SiteID, conversation.ID, actor.UserID, messageID)
}

// load reads a conversation and enforces membership.
func (s *Service) load(ctx context.Context, actor Actor, conversationID string) (Conversation, error) {
	conversation, err := s.repo.FindConversation(ctx, actor.SiteID, conversationID)
	if err != nil {
		return Conversation{}, err
	}
	if authErr := conversation.Authorize(actor); authErr != nil {
		// A non member must not learn that the conversation exists, so it is reported as
		// missing rather than forbidden.
		if errors.Is(authErr, ErrNotMember) {
			return Conversation{}, ErrNotFound
		}
		return Conversation{}, authErr
	}
	return conversation, nil
}
