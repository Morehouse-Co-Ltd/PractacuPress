package community

import (
	"context"
	"errors"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Repository is the persistence contract for community interactions.
type Repository interface {
	// FindComment loads a comment inside a site scope.
	FindComment(ctx context.Context, siteID, commentID string) (Comment, error)
	// InsertComment stores a comment and records the audit entry.
	InsertComment(ctx context.Context, comment Comment, audit site.AuditEntry) (Comment, error)
	// UpdateComment stores a status or body change and records the audit entry.
	UpdateComment(ctx context.Context, comment Comment, audit site.AuditEntry) (Comment, error)
	// HasReaction reports whether the user already reacted with this kind.
	HasReaction(ctx context.Context, userID, targetType, targetID, kind string) (bool, error)
	// SetReaction inserts or deletes a reaction row.
	SetReaction(ctx context.Context, reaction Reaction, active bool) error
	// HasBookmark reports whether the user bookmarked the target.
	HasBookmark(ctx context.Context, userID, targetType, targetID string) (bool, error)
	// SetBookmark inserts or deletes a bookmark row.
	SetBookmark(ctx context.Context, siteID, userID, targetType, targetID string, active bool) error
	// HasFollow reports whether follower follows followee.
	HasFollow(ctx context.Context, siteID, followerID, followeeID string) (bool, error)
	// SetFollow inserts or deletes a follow row.
	SetFollow(ctx context.Context, siteID, followerID, followeeID string, active bool) error
}

// Service implements comments and idempotent interactions.
type Service struct {
	repo Repository
	now  func() time.Time
}

// NewService builds a Service.
func NewService(repo Repository) (*Service, error) {
	if repo == nil {
		return nil, errors.New("community: repository is required")
	}
	return &Service{repo: repo, now: func() time.Time { return time.Now().UTC() }}, nil
}

// AddComment stores a comment or reply.
//
// The parent is loaded first so the depth limit and the site scope are checked
// against the stored row, not against whatever the client claimed.
func (s *Service) AddComment(ctx context.Context, actor Actor, in NewCommentInput) (Comment, error) {
	validated, err := ValidateComment(in)
	if err != nil {
		return Comment{}, err
	}

	var parent *Comment
	if validated.ParentID != "" {
		found, findErr := s.repo.FindComment(ctx, actor.SiteID, validated.ParentID)
		if findErr != nil {
			return Comment{}, findErr
		}
		parent = &found
	}

	depth, err := NextDepth(parent)
	if err != nil {
		return Comment{}, err
	}

	now := s.now()
	comment := Comment{
		SiteID:     actor.SiteID,
		AuthorID:   actor.UserID,
		TargetType: validated.TargetType,
		TargetID:   validated.TargetID,
		ParentID:   validated.ParentID,
		Depth:      depth,
		Body:       validated.Body,
		Status:     CommentStatusVisible,
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	return s.repo.InsertComment(ctx, comment, site.AuditEntry{
		SiteID:  actor.SiteID,
		ActorID: actor.UserID,
		Action:  "community.comment.created",
		Detail:  map[string]any{"target_type": string(validated.TargetType)},
		At:      now,
	})
}

// EditComment changes a comment body.
func (s *Service) EditComment(ctx context.Context, actor Actor, commentID, body string) (Comment, error) {
	comment, err := s.repo.FindComment(ctx, actor.SiteID, commentID)
	if err != nil {
		return Comment{}, err
	}
	if !comment.CanEdit(actor) {
		return Comment{}, ErrPermissionDenied
	}

	updated, err := ValidateComment(NewCommentInput{
		TargetType: comment.TargetType,
		TargetID:   comment.TargetID,
		Body:       body,
	})
	if err != nil {
		return Comment{}, err
	}

	comment.Body = updated.Body
	comment.UpdatedAt = s.now()

	return s.repo.UpdateComment(ctx, comment, site.AuditEntry{
		SiteID:  actor.SiteID,
		ActorID: actor.UserID,
		Action:  "community.comment.edited",
		Target:  comment.ID,
		At:      s.now(),
	})
}

// DeleteComment soft deletes a comment.
func (s *Service) DeleteComment(ctx context.Context, actor Actor, commentID string) (Comment, error) {
	comment, err := s.repo.FindComment(ctx, actor.SiteID, commentID)
	if err != nil {
		return Comment{}, err
	}
	if !comment.CanDelete(actor) {
		return Comment{}, ErrPermissionDenied
	}

	comment.Status = CommentStatusDeleted
	comment.UpdatedAt = s.now()

	return s.repo.UpdateComment(ctx, comment, site.AuditEntry{
		SiteID:  actor.SiteID,
		ActorID: actor.UserID,
		Action:  "community.comment.deleted",
		Target:  comment.ID,
		At:      s.now(),
	})
}

// ToggleReaction adds or removes a reaction. desired nil flips the current state.
func (s *Service) ToggleReaction(
	ctx context.Context,
	actor Actor,
	targetType TargetType,
	targetID string,
	kind string,
	desired *bool,
) (bool, error) {
	if !targetType.Valid() {
		return false, ErrInvalidInput
	}
	normalizedKind, err := ValidateReactionKind(kind)
	if err != nil {
		return false, err
	}

	current, err := s.repo.HasReaction(ctx, actor.UserID, string(targetType), targetID, normalizedKind)
	if err != nil {
		return false, err
	}

	decision := Toggle(current, desired)
	if !decision.Changed {
		return decision.Active, nil
	}

	if err := s.repo.SetReaction(ctx, Reaction{
		SiteID:     actor.SiteID,
		UserID:     actor.UserID,
		TargetType: targetType,
		TargetID:   targetID,
		Kind:       normalizedKind,
	}, decision.Active); err != nil {
		return false, err
	}
	return decision.Active, nil
}

// ToggleBookmark adds or removes a bookmark.
func (s *Service) ToggleBookmark(
	ctx context.Context,
	actor Actor,
	targetType TargetType,
	targetID string,
	desired *bool,
) (bool, error) {
	if !targetType.Valid() || targetID == "" {
		return false, ErrInvalidInput
	}

	current, err := s.repo.HasBookmark(ctx, actor.UserID, string(targetType), targetID)
	if err != nil {
		return false, err
	}

	decision := Toggle(current, desired)
	if !decision.Changed {
		return decision.Active, nil
	}

	if err := s.repo.SetBookmark(ctx, actor.SiteID, actor.UserID, string(targetType), targetID,
		decision.Active); err != nil {
		return false, err
	}
	return decision.Active, nil
}

// ToggleFollow adds or removes a follow relationship.
func (s *Service) ToggleFollow(ctx context.Context, actor Actor, followeeID string, desired *bool) (bool, error) {
	if err := ValidateFollow(actor.UserID, followeeID); err != nil {
		return false, err
	}

	current, err := s.repo.HasFollow(ctx, actor.SiteID, actor.UserID, followeeID)
	if err != nil {
		return false, err
	}

	decision := Toggle(current, desired)
	if !decision.Changed {
		return decision.Active, nil
	}

	if err := s.repo.SetFollow(ctx, actor.SiteID, actor.UserID, followeeID, decision.Active); err != nil {
		return false, err
	}
	return decision.Active, nil
}
