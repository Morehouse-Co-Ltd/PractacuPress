package community

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/safety"
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
	// Title and Kind are read model fields used to render a notification. They are
	// empty for a target this version cannot resolve.
	Title string
	Kind  string
	// CommentPolicy is the item level override of the site comment switches. The
	// zero value follows the site, so an older resolver keeps working.
	CommentPolicy ContentCommentPolicy
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

// CommentPolicyResolver reads the site level comment switches.
//
// Both switches are enforced in this package rather than by the browser: a client
// that calls POST /comments directly must obey the same policy as one that uses the
// rendered comment form.
type CommentPolicyResolver interface {
	CommentPolicy(ctx context.Context, siteID string) (enabled, requireReview bool, err error)
}

// CommentGuard applies the site's content safety policy to a comment write.
//
// It covers the sensitive word list and the per-user / per-IP frequency windows. The
// safety service implements it; when the server does not wire one (tests, legacy
// callers) the write proceeds unfiltered, which is the documented degraded mode.
type CommentGuard interface {
	CheckComment(ctx context.Context, in safety.CommentSubmission) (safety.CommentVerdict, error)
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

// WithCommentPolicy installs the site level comment switches used by AddComment.
// When it is not set (tests and legacy callers) comments stay open and publish
// immediately; the server must pass it.
func WithCommentPolicy(resolver CommentPolicyResolver) ServiceOption {
	return func(s *Service) { s.commentPolicy = resolver }
}

// WithCommentGuard installs the sensitive word and frequency guard used by
// AddComment and EditComment. When it is not set those writes skip the guard; the
// server must pass it.
func WithCommentGuard(guard CommentGuard) ServiceOption {
	return func(s *Service) {
		if guard != nil {
			s.guard = guard
		}
	}
}

// WithNotifier installs the inbox writer used when an interaction happens.
//
// When it is not set the interaction is still written; only the notification is
// skipped. That is the same degraded mode as a missing AuthorLookup.
func WithNotifier(notifier Notifier) ServiceOption {
	return func(s *Service) {
		if notifier != nil {
			s.notifier = notifier
		}
	}
}

// Service implements comments and idempotent interactions.
type Service struct {
	repo    Repository
	authors AuthorLookup
	// targets and members are nil when the server did not wire the optional checks;
	// in that case the corresponding validation is skipped.
	targets       ContentTargetChecker
	members       UserMembershipChecker
	commentPolicy CommentPolicyResolver
	guard         CommentGuard
	notifier      Notifier
	now           func() time.Time
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

	// The parent is loaded first so a reply is governed by the root item's comment
	// policy as well as by the parent's depth. Loading it here also means the
	// target resolver can walk a reply chain back to the article or post.
	var parent *Comment
	if validated.ParentID != "" {
		found, findErr := s.repo.FindComment(ctx, actor.SiteID, validated.ParentID)
		if findErr != nil {
			return Comment{}, findErr
		}
		parent = &found
	}

	target, tracked, err := s.commentTarget(ctx, actor, validated, parent)
	if err != nil {
		return Comment{}, err
	}
	if tracked && !target.Published &&
		!(actor.UserID != "" && target.AuthorID == actor.UserID) {
		// Not visible: answer exactly like a missing target so an unpublished id
		// cannot be probed through comments.
		return Comment{}, ErrTargetNotFound
	}

	// The site policy is the baseline; a content level override wins over it. Both
	// run before anything is written, so a direct API call obeys the same rule as
	// the rendered comment form.
	siteEnabled, siteReview := true, false
	if s.commentPolicy != nil {
		enabled, requireReview, policyErr := s.commentPolicy.CommentPolicy(ctx, actor.SiteID)
		if policyErr != nil {
			return Comment{}, policyErr
		}
		siteEnabled, siteReview = enabled, requireReview
	}
	enabled, requireReview := siteEnabled, siteReview
	if tracked {
		switch target.CommentPolicy {
		case CommentPolicyDisabled:
			return Comment{}, ErrCommentsClosed
		case CommentPolicyOpen:
			enabled, requireReview = true, false
		case CommentPolicyReview:
			enabled, requireReview = true, true
		}
	}
	if !enabled {
		return Comment{}, ErrCommentsClosed
	}

	status := CommentStatusVisible
	if requireReview {
		status = CommentStatusPending
	}

	// Content safety runs after the site switch but before any write: a matched reject
	// word refuses the submission, a matched replace word rewrites the body, and a
	// matched review word sends the comment to the moderation queue. The guard also
	// consumes the per-user / per-IP frequency windows, so it must run on every
	// attempt, including one the word list later refuses.
	var safetyVerdict safety.CommentVerdict
	if s.guard != nil {
		verdict, err := s.guard.CheckComment(ctx, safety.CommentSubmission{
			SiteID: actor.SiteID,
			UserID: actor.UserID,
			IP:     actor.IP,
			Body:   validated.Body,
		})
		if err != nil {
			return Comment{}, err
		}
		validated.Body = verdict.Body
		safetyVerdict = verdict
		if verdict.RequireReview {
			status = CommentStatusPending
		}
	}

	depth, err := NextDepth(parent)
	if err != nil {
		return Comment{}, err
	}

	now := s.now()
	// The score is computed from the body that will be stored: the safety guard may
	// have rewritten it, and a moderator reviews what was published, not what was
	// submitted.
	riskScore, riskFlags := AssessRisk(validated.Body)
	comment := Comment{
		SiteID:     actor.SiteID,
		AuthorID:   actor.UserID,
		TargetType: validated.TargetType,
		TargetID:   validated.TargetID,
		ParentID:   validated.ParentID,
		Depth:      depth,
		Body:       validated.Body,
		Status:     status,
		RiskScore:  riskScore,
		RiskFlags:  riskFlags,
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	detail := map[string]any{"target_type": string(validated.TargetType)}
	if safetyVerdict.Hit() {
		detail["content_safety"] = safetyDetail(safetyVerdict.Matched, safetyVerdict.Mode)
	}
	// The assessment is audited with the write, so a later re-tuning of the weights
	// cannot rewrite why this comment was ranked when it arrived.
	if riskScore > 0 {
		detail["risk_score"] = riskScore
		detail["risk_flags"] = riskFlags
	}

	// A pending comment is not public yet, so the target author is not notified until
	// a moderator approves it.
	notification := ""
	if status == CommentStatusVisible {
		notification = s.notifyFor(ctx, actor, validated.TargetType, validated.TargetID)
	}
	created, err := s.repo.InsertComment(ctx, comment, notification, site.AuditEntry{
		SiteID:  actor.SiteID,
		ActorID: actor.UserID,
		Action:  "community.comment.created",
		Detail:  detail,
		At:      now,
	})
	if err != nil {
		return Comment{}, err
	}
	if status == CommentStatusVisible {
		s.notifyCommentPublished(ctx, actor, created, parent)
	}
	return created, nil
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

// commentTarget resolves the article or post a comment belongs to.
//
// A top level comment names the content directly. A reply names its parent comment,
// so the parent chain is walked until the content target is found; that is what lets
// the item level comment policy apply to replies as well. A target type this version
// cannot resolve (a custom page or a user) is reported as not tracked, preserving the
// previous behaviour for those surfaces.
func (s *Service) commentTarget(
	ctx context.Context,
	actor Actor,
	in NewCommentInput,
	parent *Comment,
) (Target, bool, error) {
	if s.targets == nil {
		return Target{}, false, nil
	}

	targetType, targetID := in.TargetType, in.TargetID
	current := parent
	// The reply depth is bounded by MaxCommentDepth, so this loop is bounded too;
	// the explicit guard keeps a corrupt cycle from hanging a request.
	for hops := 0; hops <= MaxReplyDepth+1; hops++ {
		switch targetType {
		case TargetArticle, TargetPost:
			target, err := s.targets.TargetOf(ctx, actor.SiteID, targetType, targetID)
			if err != nil {
				return Target{}, false, err
			}
			return target, true, nil
		case TargetComment:
			if current == nil {
				found, err := s.repo.FindComment(ctx, actor.SiteID, targetID)
				if err != nil {
					return Target{}, false, err
				}
				current = &found
			}
			targetType, targetID = current.TargetType, current.TargetID
			current = nil
		default:
			return Target{}, false, nil
		}
	}
	return Target{}, false, nil
}

// requirePublishedTarget refuses an interaction with content that is not published.
//
// It runs only when an interaction is being turned on, so a stale reaction or bookmark
// can still be removed after its target was archived. The resolved target is returned
// so the caller can put its title into the notification.
func (s *Service) requirePublishedTarget(
	ctx context.Context,
	actor Actor,
	targetType TargetType,
	targetID string,
) (Target, error) {
	target, tracked, err := s.resolveTrackedTarget(ctx, actor, targetType, targetID)
	if err != nil {
		return Target{}, err
	}
	if !tracked || target.Published {
		return target, nil
	}
	return Target{}, ErrTargetNotFound
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

	// An edit is a new submission of text, so it goes through the same word list.
	// Skipping it would let an author publish a clean comment and immediately rewrite
	// it with the words the filter exists to stop.
	detail := map[string]any(nil)
	if s.guard != nil {
		verdict, guardErr := s.guard.CheckComment(ctx, safety.CommentSubmission{
			SiteID: actor.SiteID,
			UserID: actor.UserID,
			IP:     actor.IP,
			Body:   updated.Body,
		})
		if guardErr != nil {
			return Comment{}, guardErr
		}
		updated.Body = verdict.Body
		if verdict.Hit() {
			detail = map[string]any{
				"content_safety": safetyDetail(verdict.Matched, verdict.Mode),
			}
		}
		if verdict.RequireReview {
			comment.Status = CommentStatusPending
		}
	}

	// An edit is a new submission of text, so it is scored again for the same reason it
	// goes through the word filter: publishing a clean comment and rewriting it into
	// spam afterwards must not leave the queue looking at a zero risk score.
	riskScore, riskFlags := AssessRisk(updated.Body)
	comment.RiskScore = riskScore
	comment.RiskFlags = riskFlags
	if riskScore > 0 {
		if detail == nil {
			detail = map[string]any{}
		}
		detail["risk_score"] = riskScore
		detail["risk_flags"] = riskFlags
	}

	comment.Body = updated.Body
	comment.UpdatedAt = s.now()

	return s.repo.UpdateComment(ctx, comment, site.AuditEntry{
		SiteID:  actor.SiteID,
		ActorID: actor.UserID,
		Action:  "community.comment.edited",
		Target:  comment.ID,
		Detail:  detail,
		At:      s.now(),
	})
}

// safetyDetail builds the audit detail of a content safety hit.
//
// The matched words are stored server side only: they tell a moderator why a comment
// was refused or queued without turning the public response into a blocklist oracle.
func safetyDetail(matched []string, mode safety.WordMode) map[string]any {
	return map[string]any{
		"matched": matched,
		"action":  string(mode),
	}
}

// RetryAfter reports the wait time carried by a rate limit failure.
//
// It is a helper for the HTTP layer, which sets the Retry-After header before
// translating the error into problem+json.
func RetryAfter(err error) (int, bool) {
	var rateErr *safety.RateLimitError
	if !errors.As(err, &rateErr) {
		return 0, false
	}
	seconds := int(rateErr.RetryAfter / time.Second)
	if rateErr.RetryAfter%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		seconds = 1
	}
	return seconds, true
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

	updated, err := s.repo.UpdateComment(ctx, comment, site.AuditEntry{
		SiteID:  actor.SiteID,
		ActorID: actor.UserID,
		Action:  "community.comment.moderated",
		Target:  comment.ID,
		Detail:  map[string]any{"status": status},
		At:      s.now(),
	})
	if err != nil {
		return Comment{}, err
	}
	s.notifyCommentModerated(ctx, actor, updated, status)
	return updated, nil
}

// ApproveComment publishes a comment awaiting review.
//
// It is the explicit review endpoint; PATCH with a status remains available for
// hiding and restoring. Only a moderator may approve, and a deleted comment cannot be
// resurrected this way.
func (s *Service) ApproveComment(ctx context.Context, actor Actor, commentID string) (Comment, error) {
	return s.reviewComment(ctx, actor, commentID, CommentStatusVisible, "community.comment.approved")
}

// RejectComment rejects a comment awaiting review.
//
// Rejection is stored as hidden rather than deleted: the body remains as evidence for
// the author and moderators, and the decision is reversible.
func (s *Service) RejectComment(ctx context.Context, actor Actor, commentID string) (Comment, error) {
	return s.reviewComment(ctx, actor, commentID, CommentStatusHidden, "community.comment.rejected")
}

func (s *Service) reviewComment(
	ctx context.Context,
	actor Actor,
	commentID, status, action string,
) (Comment, error) {
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

	updated, err := s.repo.UpdateComment(ctx, comment, site.AuditEntry{
		SiteID:  actor.SiteID,
		ActorID: actor.UserID,
		Action:  action,
		Target:  comment.ID,
		Detail:  map[string]any{"status": status},
		At:      s.now(),
	})
	if err != nil {
		return Comment{}, err
	}

	// The author learns the decision either way; approval additionally publishes
	// the comment to the person it answers, which is the notification a pending
	// comment deliberately held back when it was written.
	s.notifyCommentModerated(ctx, actor, updated, status)
	if status == CommentStatusVisible {
		var parent *Comment
		if updated.ParentID != "" {
			if found, findErr := s.repo.FindComment(ctx, updated.SiteID, updated.ParentID); findErr == nil {
				parent = &found
			}
		}
		s.notifyCommentPublished(ctx, Actor{UserID: updated.AuthorID, SiteID: updated.SiteID}, updated, parent)
	}
	return updated, nil
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
	var target Target
	if decision.Active {
		target, err = s.requirePublishedTarget(ctx, actor, targetType, targetID)
		if err != nil {
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
	if decision.Active {
		s.notifyReaction(ctx, actor, targetType, targetID, target, normalizedKind)
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
		if _, err := s.requirePublishedTarget(ctx, actor, targetType, targetID); err != nil {
			return false, err
		}
	}

	if err := s.repo.SetBookmark(ctx, actor.SiteID, actor.UserID, string(targetType), targetID,
		decision.Active); err != nil {
		return false, err
	}
	return decision.Active, nil
}

// InteractionStateReader is the optional batch read port for the caller's own
// interaction state.
//
// It is a separate interface rather than part of Repository so existing persistence
// fakes keep compiling; the Ent store implements both and the server always wires it.
type InteractionStateReader interface {
	HasReactionsFor(ctx context.Context, siteID, userID string, targetType TargetType, targetIDs []string, kind string) (map[string]bool, error)
	HasBookmarksFor(ctx context.Context, siteID, userID string, targetType TargetType, targetIDs []string) (map[string]bool, error)
	HasFollowsFor(ctx context.Context, siteID, followerID string, followeeIDs []string) (map[string]bool, error)
}

// InteractionListReader is the optional read port behind the personal lists and the
// reading history. It is split from Repository for the same reason as
// InteractionStateReader.
type InteractionListReader interface {
	ListBookmarks(ctx context.Context, filter InteractionListFilter) ([]InteractionEntry, error)
	ListReactions(ctx context.Context, filter InteractionListFilter) ([]InteractionEntry, error)
	ListFollowing(ctx context.Context, filter FollowListFilter) ([]FollowEntry, error)
	ListFollowers(ctx context.Context, filter FollowListFilter) ([]FollowEntry, error)
	RecordReading(ctx context.Context, entry ReadingEntry) error
	ListReadingHistory(ctx context.Context, filter InteractionListFilter) ([]ReadingEntryView, error)
}

var errReadPortMissing = errors.New("community: interaction read port is not configured")

func (s *Service) stateReader() (InteractionStateReader, error) {
	reader, ok := s.repo.(InteractionStateReader)
	if !ok {
		return nil, errReadPortMissing
	}
	return reader, nil
}

func (s *Service) listReader() (InteractionListReader, error) {
	reader, ok := s.repo.(InteractionListReader)
	if !ok {
		return nil, errReadPortMissing
	}
	return reader, nil
}

// State returns the caller's current relation to one target.
//
// An anonymous caller is a valid request and receives the all-false state: the
// public content page asks before login and must not have to special-case the 401.
func (s *Service) State(
	ctx context.Context,
	actor Actor,
	targetType TargetType,
	targetID, authorID string,
) (InteractionState, error) {
	if err := ValidateInteractionTargetType(targetType); err != nil {
		return InteractionState{}, err
	}
	targetID = strings.TrimSpace(targetID)
	if targetID == "" {
		return InteractionState{}, ErrInvalidInput
	}
	if actor.UserID == "" {
		return InteractionState{}, nil
	}

	liked, err := s.repo.HasReaction(ctx, actor.UserID, string(targetType), targetID, "like")
	if err != nil {
		return InteractionState{}, err
	}
	bookmarked, err := s.repo.HasBookmark(ctx, actor.UserID, string(targetType), targetID)
	if err != nil {
		return InteractionState{}, err
	}

	// Following is a relation to a member, not to a piece of content. The caller
	// either names the author explicitly or asks about a user target directly.
	followeeID := strings.TrimSpace(authorID)
	if targetType == TargetUser {
		followeeID = targetID
	}
	following := false
	if followeeID != "" && followeeID != actor.UserID {
		following, err = s.repo.HasFollow(ctx, actor.SiteID, actor.UserID, followeeID)
		if err != nil {
			return InteractionState{}, err
		}
	}
	return InteractionState{Liked: liked, Bookmarked: bookmarked, Following: following}, nil
}

// States returns the interaction state of a batch of targets plus the follow state
// of every requested member.
//
// The batch form exists so an archive grid does not issue one request per card.
func (s *Service) States(
	ctx context.Context,
	actor Actor,
	targetType TargetType,
	targetIDs, authorIDs []string,
) ([]InteractionStateItem, []FollowStateItem, error) {
	if err := ValidateInteractionTargetType(targetType); err != nil {
		return nil, nil, err
	}
	ids, err := NormalizeInteractionIDs(targetIDs)
	if err != nil {
		return nil, nil, err
	}
	authors, err := NormalizeInteractionIDs(authorIDs)
	if err != nil {
		return nil, nil, err
	}

	items := make([]InteractionStateItem, 0, len(ids))
	follows := make([]FollowStateItem, 0, len(authors))
	if actor.UserID == "" {
		for _, id := range ids {
			items = append(items, InteractionStateItem{TargetID: id})
		}
		for _, id := range authors {
			follows = append(follows, FollowStateItem{UserID: id})
		}
		return items, follows, nil
	}

	reader, err := s.stateReader()
	if err != nil {
		return nil, nil, err
	}
	likes := map[string]bool{}
	bookmarks := map[string]bool{}
	if len(ids) > 0 {
		likes, err = reader.HasReactionsFor(ctx, actor.SiteID, actor.UserID, targetType, ids, "like")
		if err != nil {
			return nil, nil, err
		}
		bookmarks, err = reader.HasBookmarksFor(ctx, actor.SiteID, actor.UserID, targetType, ids)
		if err != nil {
			return nil, nil, err
		}
	}
	following := map[string]bool{}
	if len(authors) > 0 {
		following, err = reader.HasFollowsFor(ctx, actor.SiteID, actor.UserID, authors)
		if err != nil {
			return nil, nil, err
		}
	}

	for _, id := range ids {
		items = append(items, InteractionStateItem{
			TargetID:   id,
			Liked:      likes[id],
			Bookmarked: bookmarks[id],
		})
	}
	for _, id := range authors {
		follows = append(follows, FollowStateItem{UserID: id, Following: following[id]})
	}
	return items, follows, nil
}

// Bookmarks returns the caller's saved content, newest first.
func (s *Service) Bookmarks(
	ctx context.Context,
	actor Actor,
	filter InteractionListFilter,
) ([]InteractionEntry, string, error) {
	return s.listInteractions(ctx, actor, filter, false)
}

// Likes returns the content the caller liked, newest first.
func (s *Service) Likes(
	ctx context.Context,
	actor Actor,
	filter InteractionListFilter,
) ([]InteractionEntry, string, error) {
	return s.listInteractions(ctx, actor, filter, true)
}

func (s *Service) listInteractions(
	ctx context.Context,
	actor Actor,
	filter InteractionListFilter,
	reactions bool,
) ([]InteractionEntry, string, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return nil, "", ErrPermissionDenied
	}
	if filter.TargetType != "" {
		if err := ValidateInteractionTargetType(filter.TargetType); err != nil {
			return nil, "", err
		}
	}
	filter.SiteID = actor.SiteID
	filter.UserID = actor.UserID
	filter.Limit = NormalizeInteractionLimit(filter.Limit)
	if reactions {
		kind := filter.Kind
		if kind == "" {
			kind = "like"
		}
		normalized, err := ValidateReactionKind(kind)
		if err != nil {
			return nil, "", err
		}
		filter.Kind = normalized
	}

	reader, err := s.listReader()
	if err != nil {
		return nil, "", err
	}
	var entries []InteractionEntry
	if reactions {
		entries, err = reader.ListReactions(ctx, filter)
	} else {
		entries, err = reader.ListBookmarks(ctx, filter)
	}
	if err != nil {
		return nil, "", err
	}
	return entries, interactionNextCursor(entries, filter.Limit), nil
}

// Following returns the members the caller follows.
func (s *Service) Following(
	ctx context.Context,
	actor Actor,
	filter FollowListFilter,
) ([]FollowEntry, string, error) {
	return s.listFollows(ctx, actor, filter, false)
}

// Followers returns the members who follow the caller.
func (s *Service) Followers(
	ctx context.Context,
	actor Actor,
	filter FollowListFilter,
) ([]FollowEntry, string, error) {
	return s.listFollows(ctx, actor, filter, true)
}

func (s *Service) listFollows(
	ctx context.Context,
	actor Actor,
	filter FollowListFilter,
	followers bool,
) ([]FollowEntry, string, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return nil, "", ErrPermissionDenied
	}
	filter.SiteID = actor.SiteID
	filter.UserID = actor.UserID
	filter.Limit = NormalizeInteractionLimit(filter.Limit)

	reader, err := s.listReader()
	if err != nil {
		return nil, "", err
	}
	var entries []FollowEntry
	if followers {
		entries, err = reader.ListFollowers(ctx, filter)
	} else {
		entries, err = reader.ListFollowing(ctx, filter)
	}
	if err != nil {
		return nil, "", err
	}

	next := ""
	if len(entries) == filter.Limit && len(entries) > 0 {
		last := entries[len(entries)-1]
		next = page.Cursor{
			Key: last.Since.UTC().Format(time.RFC3339Nano),
			ID:  last.UserID,
		}.Encode()
	}
	return entries, next, nil
}

// RecordReading stores the caller's visit to one content item.
//
// The target must be a published article or post, so a stale tab cannot write a
// history row for content that was archived or never existed.
func (s *Service) RecordReading(ctx context.Context, actor Actor, targetType TargetType, targetID string) error {
	if actor.UserID == "" || actor.SiteID == "" {
		return ErrPermissionDenied
	}
	targetID = strings.TrimSpace(targetID)
	if err := ValidateReadingTarget(targetType, targetID); err != nil {
		return err
	}
	if _, err := s.requirePublishedTarget(ctx, actor, targetType, targetID); err != nil {
		return err
	}
	reader, err := s.listReader()
	if err != nil {
		return err
	}
	return reader.RecordReading(ctx, ReadingEntry{
		SiteID:     actor.SiteID,
		UserID:     actor.UserID,
		TargetType: targetType,
		TargetID:   targetID,
		At:         s.now(),
	})
}

// ReadingHistory returns the caller's recently read content, newest first.
func (s *Service) ReadingHistory(
	ctx context.Context,
	actor Actor,
	filter InteractionListFilter,
) ([]ReadingEntryView, string, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return nil, "", ErrPermissionDenied
	}
	if filter.TargetType != "" {
		if err := ValidateInteractionTargetType(filter.TargetType); err != nil {
			return nil, "", err
		}
	}
	filter.SiteID = actor.SiteID
	filter.UserID = actor.UserID
	filter.Limit = NormalizeInteractionLimit(filter.Limit)

	reader, err := s.listReader()
	if err != nil {
		return nil, "", err
	}
	entries, err := reader.ListReadingHistory(ctx, filter)
	if err != nil {
		return nil, "", err
	}

	next := ""
	if len(entries) == filter.Limit && len(entries) > 0 {
		last := entries[len(entries)-1]
		next = page.Cursor{
			Key: last.LastViewedAt.UTC().Format(time.RFC3339Nano),
			ID:  last.TargetID,
		}.Encode()
	}
	return entries, next, nil
}

// interactionNextCursor builds the opaque cursor of the next interaction page.
func interactionNextCursor(entries []InteractionEntry, limit int) string {
	if len(entries) != limit || len(entries) == 0 {
		return ""
	}
	last := entries[len(entries)-1]
	return page.Cursor{
		Key: last.CreatedAt.UTC().Format(time.RFC3339Nano),
		ID:  last.TargetID,
	}.Encode()
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
	if decision.Active {
		s.notifyFollow(ctx, actor, followeeID)
	}
	return decision.Active, nil
}
