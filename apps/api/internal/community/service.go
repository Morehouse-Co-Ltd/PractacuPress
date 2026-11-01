package community

import (
	"context"
	"errors"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Repository is the persistence contract for community interactions.
type Repository interface {
	// FindComment loads a comment inside a site scope.
	FindComment(ctx context.Context, siteID, commentID string) (Comment, error)
	// ListComments returns a page of comments ordered newest first.
	ListComments(ctx context.Context, filter CommentListFilter) ([]Comment, error)
	// InsertComment stores a comment, the notification event for its target author and
	// the audit entry in one transaction. notifyUserID empty means nobody is told.
	InsertComment(ctx context.Context, comment Comment, notifyUserID string, audit site.AuditEntry) (Comment, error)
	// UpdateComment stores a status or body change and records the audit entry.
	UpdateComment(ctx context.Context, comment Comment, audit site.AuditEntry) (Comment, error)
	// HasReaction reports whether the user already reacted with this kind.
	HasReaction(ctx context.Context, userID, targetType, targetID, kind string) (bool, error)
	// SetReaction inserts or deletes a reaction row. When active and notifyUserID is
	// non empty, a notification event is written in the same transaction.
	SetReaction(ctx context.Context, reaction Reaction, active bool, notifyUserID string) error
	// HasBookmark reports whether the user bookmarked the target.
	HasBookmark(ctx context.Context, userID, targetType, targetID string) (bool, error)
	// SetBookmark inserts or deletes a bookmark row.
	SetBookmark(ctx context.Context, siteID, userID, targetType, targetID string, active bool) error
	// HasFollow reports whether follower follows followee.
	HasFollow(ctx context.Context, siteID, followerID, followeeID string) (bool, error)
	// SetFollow inserts or deletes a follow row.
	SetFollow(ctx context.Context, siteID, followerID, followeeID string, active bool) error
}

// AuthorLookup resolves the author of an interaction target.
//
// It is a port rather than a direct query so the module does not depend on the content
// package: comments, reactions and bookmarks share one notion of "who owns this".
type AuthorLookup interface {
	AuthorOf(ctx context.Context, siteID string, targetType TargetType, targetID string) (string, error)
}

// Service implements comments and idempotent interactions.
type Service struct {
	repo    Repository
	authors AuthorLookup
	now     func() time.Time
}

// NewService builds a Service.
func NewService(repo Repository, authors AuthorLookup) (*Service, error) {
	if repo == nil {
		return nil, errors.New("community: repository is required")
	}
	if authors == nil {
		// Without a lookup nothing can be notified. That is a valid degraded mode: the
		// interaction still lands, only the notification is skipped.
		authors = missingLookup{}
	}
	return &Service{repo: repo, authors: authors, now: func() time.Time { return time.Now().UTC() }}, nil
}

type missingLookup struct{}

func (missingLookup) AuthorOf(context.Context, string, TargetType, string) (string, error) {
	return "", ErrNotFound
}

// notifyFor decides who should hear about an interaction.
//
// Self interaction never notifies, and an unresolvable author is not an error: the
// comment or reaction is the user visible outcome, the notification is secondary.
func (s *Service) notifyFor(ctx context.Context, actor Actor, targetType TargetType, targetID string) string {
	author, err := s.authors.AuthorOf(ctx, actor.SiteID, targetType, targetID)
	if err != nil || author == "" || author == actor.UserID {
		return ""
	}
	return author
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

	notification := s.notifyFor(ctx, actor, validated.TargetType, validated.TargetID)
	return s.repo.InsertComment(ctx, comment, notification, site.AuditEntry{
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

// ListComments returns a page of comments and the cursor for the next page.
//
// Authorisation is decided here, not by the caller: a reader without moderation
// rights is pinned to visible comments no matter what the query asked for.
func (s *Service) ListComments(
	ctx context.Context,
	actor Actor,
	filter CommentListFilter,
) ([]Comment, string, error) {
	if actor.SiteID == "" {
		return nil, "", ErrPermissionDenied
	}
	filter.SiteID = actor.SiteID
	if filter.TargetType != "" {
		if !filter.TargetType.Valid() || filter.TargetType == TargetUser {
			return nil, "", ErrInvalidInput
		}
	}

	moderator := CanModerate(actor)
	for _, status := range filter.Statuses {
		if !ValidCommentStatus(status) {
			return nil, "", ErrInvalidInput
		}
		if !moderator && status != CommentStatusVisible {
			return nil, "", ErrPermissionDenied
		}
	}
	if len(filter.Statuses) == 0 {
		if moderator {
			filter.Statuses = []string{
				CommentStatusVisible,
				CommentStatusPending,
				CommentStatusHidden,
				CommentStatusDeleted,
			}
		} else {
			filter.Statuses = []string{CommentStatusVisible}
		}
	}
	if filter.Limit <= 0 || filter.Limit > 100 {
		filter.Limit = 20
	}

	items, err := s.repo.ListComments(ctx, filter)
	if err != nil {
		return nil, "", err
	}

	next := ""
	if len(items) == filter.Limit && len(items) > 0 {
		last := items[len(items)-1]
		next = page.Cursor{Key: last.CreatedAt.UTC().Format(time.RFC3339Nano), ID: last.ID}.Encode()
	}
	return items, next, nil
}

// ModerateComment changes the visibility of a comment.
//
// Hiding is reversible and never touches the body, so a moderation decision keeps the
// evidence intact. Permanent removal is the delete endpoint's job.
func (s *Service) ModerateComment(ctx context.Context, actor Actor, commentID, status string) (Comment, error) {
	if !CanModerate(actor) {
		return Comment{}, ErrPermissionDenied
	}
	if status != CommentStatusVisible && status != CommentStatusHidden {
		return Comment{}, ErrInvalidInput
	}

	comment, err := s.repo.FindComment(ctx, actor.SiteID, commentID)
	if err != nil {
		return Comment{}, err
	}
	if comment.Status == CommentStatusDeleted {
		return Comment{}, ErrInvalidInput
	}
	if comment.Status == status {
		return comment, nil
	}

	comment.Status = status
	comment.UpdatedAt = s.now()

	return s.repo.UpdateComment(ctx, comment, site.AuditEntry{
		SiteID:  actor.SiteID,
		ActorID: actor.UserID,
		Action:  "community.comment.moderated",
		Target:  comment.ID,
		Detail:  map[string]any{"status": status},
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
	}, decision.Active, s.reactionRecipient(ctx, actor, targetType, targetID, decision)); err != nil {
		return false, err
	}
	return decision.Active, nil
}

// reactionRecipient returns the target author only when the reaction switched on.
func (s *Service) reactionRecipient(
	ctx context.Context,
	actor Actor,
	targetType TargetType,
	targetID string,
	decision ToggleDecision,
) string {
	if !decision.Active {
		return ""
	}
	return s.notifyFor(ctx, actor, targetType, targetID)
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
