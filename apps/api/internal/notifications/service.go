package notifications

import (
	"context"
	"errors"
	"time"
)

// Repository is the persistence contract for notifications.
type Repository interface {
	Insert(ctx context.Context, item Notification) (Notification, error)
	List(ctx context.Context, siteID, userID string, limit int) ([]Notification, error)
	Find(ctx context.Context, siteID, userID, notificationID string) (Notification, error)
	MarkRead(ctx context.Context, notificationID string, at time.Time) error
	MarkAllRead(ctx context.Context, siteID, userID string, at time.Time) (int, error)
}

// Actor is the caller.
type Actor struct {
	UserID string
	SiteID string
}

// Bounds.
const (
	// DefaultInboxLimit is the inbox page size.
	DefaultInboxLimit = 30
	// MaxInboxLimit caps the page size.
	MaxInboxLimit = 100
)

// Service implements the notification use cases.
type Service struct {
	repo Repository
	now  func() time.Time
}

// NewService builds a Service.
func NewService(repo Repository) (*Service, error) {
	if repo == nil {
		return nil, errors.New("notifications: repository is required")
	}
	return &Service{repo: repo, now: func() time.Time { return time.Now().UTC() }}, nil
}

// Notify creates a notification for one user.
//
// It is called by the modules that produce events, so validation lives here rather than
// in the caller: a notification with a bad payload must be rejected before it reaches
// the inbox.
func (s *Service) Notify(ctx context.Context, in NewInput) (Notification, error) {
	validated, err := Validate(in)
	if err != nil {
		return Notification{}, err
	}

	return s.repo.Insert(ctx, Notification{
		SiteID:    validated.SiteID,
		UserID:    validated.UserID,
		Type:      validated.Type,
		ActorID:   validated.ActorID,
		SubjectID: validated.SubjectID,
		Payload:   validated.Payload,
		CreatedAt: s.now(),
	})
}

// Inbox returns the caller's notifications, newest first.
func (s *Service) Inbox(ctx context.Context, actor Actor, limit int) ([]Notification, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return nil, ErrInvalidInput
	}
	if limit <= 0 || limit > MaxInboxLimit {
		limit = DefaultInboxLimit
	}
	return s.repo.List(ctx, actor.SiteID, actor.UserID, limit)
}

// MarkRead marks one notification read.
//
// Marking an already read notification is a no-op, so the endpoint is safe to retry.
func (s *Service) MarkRead(ctx context.Context, actor Actor, notificationID string) (Notification, error) {
	found, err := s.repo.Find(ctx, actor.SiteID, actor.UserID, notificationID)
	if err != nil {
		return Notification{}, err
	}

	updated, changed, err := found.MarkRead(actor.UserID, actor.SiteID, s.now())
	if err != nil {
		return Notification{}, err
	}
	if !changed {
		return updated, nil
	}
	if markErr := s.repo.MarkRead(ctx, notificationID, *updated.ReadAt); markErr != nil {
		return Notification{}, markErr
	}
	return updated, nil
}

// MarkAllRead clears the caller's unread badge.
func (s *Service) MarkAllRead(ctx context.Context, actor Actor) (int, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return 0, ErrInvalidInput
	}
	return s.repo.MarkAllRead(ctx, actor.SiteID, actor.UserID, s.now())
}
