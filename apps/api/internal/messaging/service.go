package messaging

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// MembershipChecker reports whether a user is an active member of a site.
//
// It is the authorization port used when a conversation is created: a conversation
// must not name a user who does not exist, belongs to another site, or has been
// suspended. The server wires it over the site membership service.
type MembershipChecker interface {
	IsActiveMember(ctx context.Context, siteID, userID string) (bool, error)
}

// ServiceOption customises a Service without breaking existing callers.
type ServiceOption func(*Service)

// WithMembershipChecker installs the active membership check used by StartConversation.
//
// Without it the check is skipped, which is the pre-hardening behaviour: callers that
// do not pass the option still compile, but the server must pass it so a client cannot
// inject arbitrary user ids into a conversation (V-14).
func WithMembershipChecker(checker MembershipChecker) ServiceOption {
	return func(s *Service) { s.members = checker }
}

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
	// members is nil when the deployment did not wire the membership check; in that
	// case conversation creation trusts the supplied user ids.
	members MembershipChecker
}

// NewService builds a Service.
func NewService(repo Repository, options ...ServiceOption) (*Service, error) {
	if repo == nil {
		return nil, errors.New("messaging: repository is required")
	}
	service := &Service{repo: repo, now: func() time.Time { return time.Now().UTC() }}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service, nil
}

// StartConversation creates a thread.
//
// The caller is always a member: a conversation a user cannot read is not a useful
// thing to create, and requiring it removes a whole class of "created but invisible"
// bugs.
//
// Every member id, including the creator, must resolve to an active member of the
// actor's site when a MembershipChecker is wired. Without that check any user id
// could be written into conversation_member, letting an attacker create ghost rows or
// pull an administrator into a thread they never joined (V-14).
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

	if err := s.validateMembers(ctx, actor.SiteID, members); err != nil {
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

// validateMembers refuses conversation members that are not active on the site.
//
// An id that does not exist, belongs to another site, or is suspended answers
// ErrInvalidInput rather than ErrNotFound: the client supplied a bad member list, and
// the response must not become an account-enumeration oracle. A checker failure is
// propagated as an internal error so an outage cannot silently disable the check.
func (s *Service) validateMembers(ctx context.Context, siteID string, members []string) error {
	if s.members == nil {
		return nil
	}
	for _, memberID := range members {
		active, err := s.members.IsActiveMember(ctx, siteID, memberID)
		if err != nil {
			return err
		}
		if !active {
			return fmt.Errorf("%w: member is not an active member of this site", ErrInvalidInput)
		}
	}
	return nil
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
