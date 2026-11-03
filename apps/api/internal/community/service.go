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

// Target is the resolved state of a content interaction target.
//
// It is the minimal projection the interaction rules need: who owns the target and
// whether every reader may see it. The community module owns this shape so it does not
// import the content aggregate.
type Target struct {
	AuthorID string
	// Published reports whether the target is visible to every reader.
	Published bool
}

// ContentTargetChecker resolves article and post targets before an interaction is
// written. Returning ErrTargetNotFound for a missing row keeps the caller from
// creating relations that point at nonexistent or invisible content (V-15).
type ContentTargetChecker interface {
	TargetOf(ctx context.Context, siteID string, targetType TargetType, targetID string) (Target, error)
}

// UserMembershipChecker reports whether a user is an active member of a site.
//
// It backs the follow rule: following an unknown or suspended account would create a
// relationship to a user who can never appear in the follower's list.
type UserMembershipChecker interface {
	IsActiveMember(ctx context.Context, siteID, userID string) (bool, error)
}

// ServiceOption customises a Service without breaking existing callers.
type ServiceOption func(*Service)

// WithTargetChecker installs the content target resolver used by AddComment,
// ToggleReaction and ToggleBookmark.
//
// When it is not set those writes keep the pre-hardening behaviour of trusting the
// target id; the server must pass it (V-15).
func WithTargetChecker(checker ContentTargetChecker) ServiceOption {
	return func(s *Service) { s.targets = checker }
}

// WithMembershipChecker installs the active membership check used by ToggleFollow.
// When it is not set the follow target is not validated; the server must pass it.
func WithMembershipChecker(checker UserMembershipChecker) ServiceOption {
	return func(s *Service) { s.members = checker }
}

// Service implements comments and idempotent interactions.
type Service struct {
	repo    Repository
	authors AuthorLookup
	// targets and members are nil when the server did not wire the optional checks;
	// in that case the corresponding validation is skipped.
	targets ContentTargetChecker
	members UserMembershipChecker
	now     func() time.Time
}

// NewService builds a Service.
func NewService(repo Repository, authors AuthorLookup, options ...ServiceOption) (*Service, error) {
	if repo == nil {
		return nil, errors.New("community: repository is required")
	}
	if authors == nil {
		// Without a lookup nothing can be notified. That is a valid degraded mode: the
		// interaction still lands, only the notification is skipped.
		authors = missingLookup{}
	}
	service := &Service{repo: repo, authors: authors, now: func() time.Time { return time.Now().UTC() }}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service, nil
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
	if err := s.checkCommentTarget(ctx, actor, validated); err != nil {
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

// resolveTrackedTarget resolves article and post targets when the server wired a
// checker. The bool is false for target types this version cannot resolve: a comment
// target is reached through its parent row, while a custom page or a user has no
// publication state to check. Those keep their previous behaviour.
func (s *Service) resolveTrackedTarget(
	ctx context.Context,
	actor Actor,
	targetType TargetType,
	targetID string,
) (Target, bool, error) {
	if s.targets == nil {
		return Target{}, false, nil
	}
	switch targetType {
	case TargetArticle, TargetPost:
		target, err := s.targets.TargetOf(ctx, actor.SiteID, targetType, targetID)
		if err != nil {
			return Target{}, false, err
		}
		return target, true, nil
	default:
		return Target{}, false, nil
	}
}

// checkCommentTarget refuses a comment on content the caller cannot see: published
// content is visible to every reader, an unpublished row only to its author.
func (s *Service) checkCommentTarget(ctx context.Context, actor Actor, in NewCommentInput) error {
	target, tracked, err := s.resolveTrackedTarget(ctx, actor, in.TargetType, in.TargetID)
	if err != nil {
		return err
	}
	if !tracked || target.Published {
		return nil
	}
	if actor.UserID != "" && target.AuthorID == actor.UserID {
		return nil
	}
	// Not visible: answer exactly like a missing target so an unpublished id cannot
	// be probed through comments.
	return ErrTargetNotFound
}

// requirePublishedTarget refuses an interaction with content that is not published.
//
// It runs only when an interaction is being turned on, so a stale reaction or bookmark
// can still be removed after its target was archived.
func (s *Service) requirePublishedTarget(
	ctx context.Context,
	actor Actor,
	targetType TargetType,
	targetID string,
) error {
	target, tracked, err := s.resolveTrackedTarget(ctx, actor, targetType, targetID)
	if err != nil {
		return err
	}
	if !tracked || target.Published {
		return nil
	}
	return ErrTargetNotFound
}

// requireActiveMember refuses a follow of a user who is not an active member of the
// actor's site, which also covers unknown and suspended accounts.
func (s *Service) requireActiveMember(ctx context.Context, actor Actor, userID string) error {
	if s.members == nil {
		return nil
	}
	active, err := s.members.IsActiveMember(ctx, actor.SiteID, userID)
	if err != nil {
		return err
	}
	if !active {
		return ErrTargetNotFound
	}
	return nil
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
	// Turning a reaction on requires a visible target; turning it off must stay
	// possible after the target was archived.
	if decision.Active {
		if err := s.requirePublishedTarget(ctx, actor, targetType, targetID); err != nil {
			return false, err
		}
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
	if decision.Active {
		if err := s.requirePublishedTarget(ctx, actor, targetType, targetID); err != nil {
			return false, err
		}
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
	// A new follow must point at an active member; unfollowing a suspended account
	// must remain possible.
	if decision.Active {
		if err := s.requireActiveMember(ctx, actor, followeeID); err != nil {
			return false, err
		}
	}

	if err := s.repo.SetFollow(ctx, actor.SiteID, actor.UserID, followeeID, decision.Active); err != nil {
		return false, err
	}
	return decision.Active, nil
}
