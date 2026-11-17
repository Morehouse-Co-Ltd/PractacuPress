// Package community holds the interaction aggregate: comments, reactions, bookmarks
// and follows.
//
// All of it is idempotent by construction. A like that arrives twice must leave one
// row, and a follow that arrives twice must leave one relationship, because retries
// and impatient double clicks are normal client behaviour, not errors.
package community

import (
	"errors"
	"fmt"
	"strings"
	"time"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// TargetType names what an interaction points at.
type TargetType string

// Supported interaction targets.
const (
	TargetArticle TargetType = "article"
	TargetPost    TargetType = "post"
	TargetComment TargetType = "comment"
	TargetUser    TargetType = "user"
	// TargetPage stands for a custom site page, for example a guestbook.
	TargetPage TargetType = "page"
)

// Valid reports whether the target type is defined.
func (t TargetType) Valid() bool {
	switch t {
	case TargetArticle, TargetPost, TargetComment, TargetUser, TargetPage:
		return true
	default:
		return false
	}
}

// ContentCommentPolicy is the per item override of the site comment switches
// (C-19). The content module owns the stored value; this package only needs the
// small closed vocabulary to enforce it.
type ContentCommentPolicy string

// The per item comment policies.
const (
	// CommentPolicyInherit follows the site switches.
	CommentPolicyInherit ContentCommentPolicy = "inherit"
	// CommentPolicyOpen opens comments regardless of the site switch.
	CommentPolicyOpen ContentCommentPolicy = "open"
	// CommentPolicyDisabled closes comments for this item.
	CommentPolicyDisabled ContentCommentPolicy = "disabled"
	// CommentPolicyReview sends new comments to the moderation queue.
	CommentPolicyReview ContentCommentPolicy = "review"
)

// Comment status values.
const (
	CommentStatusVisible = "visible"
	CommentStatusHidden  = "hidden"
	CommentStatusDeleted = "deleted"
	CommentStatusPending = "pending_review"
)

// Comment status aliases used by moderation.
const (
	StatusVisible = CommentStatusVisible
	StatusHidden  = CommentStatusHidden
	StatusDeleted = CommentStatusDeleted
)

// Sentinel errors.
var (
	// ErrInvalidInput means a field failed validation.
	ErrInvalidInput = errors.New("community: invalid input")
	// ErrNotFound means the comment or interaction does not exist.
	ErrNotFound = errors.New("community: not found")
	// ErrPermissionDenied means the actor may not perform the action.
	ErrPermissionDenied = errors.New("community: permission denied")
	// ErrCrossSite means the target belongs to another site.
	ErrCrossSite = errors.New("community: cross site access")
	// ErrDepthExceeded means a reply would nest deeper than the site allows.
	ErrDepthExceeded = errors.New("community: reply depth exceeded")
	// ErrSelfTarget means the actor targeted itself, which follow and report forbid.
	ErrSelfTarget = errors.New("community: cannot target yourself")
	// ErrTargetNotFound means the interaction target does not exist on this site, or is
	// not visible to the caller. It is deliberately indistinguishable from a missing
	// row so unpublished content cannot be probed through interactions.
	ErrTargetNotFound = errors.New("community: target not found")
	// ErrCommentsClosed means the site switched comments off. It is enforced on the
	// server so a direct API call cannot post to a closed thread.
	ErrCommentsClosed = errors.New("community: comments are closed")
)

// Bounds on caller supplied content.
const (
	// MaxCommentLength bounds a comment body, in characters.
	MaxCommentLength = 5000
	// MaxReplyDepth is the deepest allowed reply nesting. Depth 0 is a top level
	// comment, so a depth of 3 means three levels of replies.
	MaxReplyDepth = 3
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

// Actor is the caller performing an interaction.
type Actor struct {
	UserID string
	SiteID string
	Role   site.Role
	// IP is the client address of the request. It is only used by the rate limiter;
	// an empty value means the caller did not supply one (tests, internal callers)
	// and only the signed-in counter applies.
	IP string
}

// Comment is one comment or reply.
type Comment struct {
	ID       string
	SiteID   string
	AuthorID string
	// AuthorName is a read model field: it is joined when listing comments and is
	// never persisted on the comment row.
	AuthorName string
	TargetType TargetType
	TargetID   string
	ParentID   string
	Depth      int
	Body       string
	Status     string
	// RiskScore is the server side assessment of the body, computed when the comment
	// is written (see AssessRisk). It is moderator only: the review queue sorts by it,
	// and a public thread must never receive it.
	RiskScore int
	// RiskFlags names the signals behind RiskScore, as stable identifiers the
	// moderator UI translates. Storage keeps them as JSON text.
	RiskFlags []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ValidCommentStatus reports whether status names a stored comment status.
func ValidCommentStatus(status string) bool {
	switch status {
	case CommentStatusVisible, CommentStatusHidden, CommentStatusDeleted, CommentStatusPending:
		return true
	default:
		return false
	}
}

// CommentListFilter narrows a comment list request.
//
// Statuses is already authorised by the service: a reader without moderation rights
// can only ever be given visible comments.
type CommentListFilter struct {
	SiteID     string
	TargetType TargetType
	TargetID   string
	Statuses   []string
	// Query matches the body and the author display name.
	Query string
	Limit int
	After page.Cursor
}

// IsAuthor reports whether the actor wrote the comment.
func (c Comment) IsAuthor(actor Actor) bool { return c.AuthorID == actor.UserID }

// CanModerate reports whether the actor may hide or delete any comment.
func CanModerate(actor Actor) bool { return actor.Role.AtLeast(site.RoleEditor) }

// CanEdit reports whether the actor may change this comment's body.
//
// Only the author may edit, and only while the comment is visible: editing a hidden
// comment would let a moderated user rewrite the evidence.
func (c Comment) CanEdit(actor Actor) bool {
	return c.IsAuthor(actor) && c.Status == CommentStatusVisible
}

// CanDelete reports whether the actor may delete this comment.
func (c Comment) CanDelete(actor Actor) bool {
	if c.IsAuthor(actor) && c.Status != CommentStatusDeleted {
		return true
	}
	return CanModerate(actor) && c.Status != CommentStatusDeleted
}

// NewCommentInput is a create request.
type NewCommentInput struct {
	TargetType TargetType
	TargetID   string
	ParentID   string
	Body       string
}

// ValidateComment normalises and validates a create request.
func ValidateComment(in NewCommentInput) (NewCommentInput, error) {
	in.Body = strings.TrimSpace(in.Body)
	in.TargetID = strings.TrimSpace(in.TargetID)
	in.ParentID = strings.TrimSpace(in.ParentID)

	if !in.TargetType.Valid() {
		return NewCommentInput{}, invalidField("target", "unknown", "unknown target type")
	}
	if in.TargetID == "" {
		return NewCommentInput{}, invalidField("target", "required", "target is required")
	}
	if in.Body == "" {
		return NewCommentInput{}, invalidField("body", "required", "body is required")
	}
	if len([]rune(in.Body)) > MaxCommentLength {
		return NewCommentInput{}, invalidField("body", "too_long", "body is too long")
	}
	if in.TargetType == TargetComment && in.ParentID == "" {
		return NewCommentInput{}, invalidField("target", "required", "reply target is required")
	}
	return in, nil
}

// NextDepth computes the depth of a reply to parent, or 0 for a top level comment.
//
// Depth is bounded so a thread cannot become an unbounded nested read; the limit is
// enforced here rather than in the handler so every entry point shares it.
func NextDepth(parent *Comment) (int, error) {
	if parent == nil {
		return 0, nil
	}
	next := parent.Depth + 1
	if next > MaxReplyDepth {
		// Three errors are wrapped: existing callers match ErrDepthExceeded, every
		// input rejection stays matchable as ErrInvalidInput, and the client gets the
		// field/rule pair. The reason keeps the operator facing text the handler used.
		return 0, fmt.Errorf("%w: %w: %w", ErrDepthExceeded, ErrInvalidInput,
			&apperr.FieldError{Field: "depth", Rule: "out_of_range", Reason: "reply depth exceeded"})
	}
	return next, nil
}

// Reaction is one user's reaction to a target.
type Reaction struct {
	ID         string
	SiteID     string
	UserID     string
	TargetType TargetType
	TargetID   string
	Kind       string
}

// ToggleDecision is the outcome of a toggle request.
type ToggleDecision struct {
	// Active is the state after the request.
	Active bool
	// Changed reports whether storage must be written.
	Changed bool
}

// Toggle computes the state a toggle request should produce.
//
// Toggling is expressed as a decision so the caller can skip the write, and so the
// outbox event is only emitted when something actually changed: a retried request
// must not produce a second notification.
func Toggle(currentlyActive bool, desired *bool) ToggleDecision {
	if desired == nil {
		// No explicit intent: flip the current state.
		return ToggleDecision{Active: !currentlyActive, Changed: true}
	}
	if *desired == currentlyActive {
		return ToggleDecision{Active: currentlyActive, Changed: false}
	}
	return ToggleDecision{Active: *desired, Changed: true}
}

// ValidateFollow rejects following yourself.
func ValidateFollow(followerID, followeeID string) error {
	if followerID == "" || followeeID == "" {
		return ErrInvalidInput
	}
	if followerID == followeeID {
		return ErrSelfTarget
	}
	return nil
}

// ValidateReactionKind bounds the reaction vocabulary.
//
// Kinds are a closed set kept in code rather than a table: adding one is a product
// decision, and an open set lets a client write arbitrary strings into an indexed
// column.
func ValidateReactionKind(kind string) (string, error) {
	kind = strings.ToLower(strings.TrimSpace(kind))
	switch kind {
	case "like", "love", "insightful":
		return kind, nil
	default:
		return "", ErrInvalidInput
	}
}

// InteractionState is the caller's own relation to one content item or member.
type InteractionState struct {
	Liked      bool
	Bookmarked bool
	Following  bool
}

// InteractionStateItem is one target's state in a batch response. Following a
// target only makes sense for a user, so it is carried separately by
// FollowStateItem.
type InteractionStateItem struct {
	TargetID   string
	Liked      bool
	Bookmarked bool
}

// FollowStateItem is one follow state in a batch response.
type FollowStateItem struct {
	UserID    string
	Following bool
}

// InteractionEntry is one saved or liked content item, enriched with the small
// read model a personal list needs (title, kind, author and publication date).
//
// The fields after CreatedAt are a read model joined by the store; they are empty
// when the target no longer exists, and Available reports that case so the page can
// render a tombstone instead of a broken link.
type InteractionEntry struct {
	TargetType  TargetType
	TargetID    string
	CreatedAt   time.Time
	Title       string
	Summary     string
	Kind        string
	AuthorID    string
	AuthorName  string
	PublishedAt *time.Time
	Available   bool
}

// ReadingEntry is one recorded visit to a content item.
type ReadingEntry struct {
	SiteID     string
	UserID     string
	TargetType TargetType
	TargetID   string
	At         time.Time
}

// ReadingEntryView is one row of the reading history list.
type ReadingEntryView struct {
	TargetType   TargetType
	TargetID     string
	LastViewedAt time.Time
	ViewCount    int
	Title        string
	Summary      string
	Kind         string
	AuthorID     string
	AuthorName   string
	PublishedAt  *time.Time
	Available    bool
}

// FollowEntry is one member in a following or followers list.
type FollowEntry struct {
	UserID        string
	DisplayName   string
	Bio           string
	AvatarMediaID string
	Since         time.Time
}

// InteractionListFilter narrows a personal interaction list.
//
// UserID always comes from the authenticated actor, never from the query string:
// the list endpoints expose one user's own data only.
type InteractionListFilter struct {
	SiteID     string
	UserID     string
	TargetType TargetType
	// Kind narrows reactions to one kind. It is empty when not relevant.
	Kind  string
	Limit int
	After page.Cursor
}

// FollowListFilter narrows a following or followers list.
type FollowListFilter struct {
	SiteID string
	UserID string
	Limit  int
	After  page.Cursor
}

// MaxInteractionBatch bounds one batch state request.
const MaxInteractionBatch = 100

// NormalizeInteractionIDs trims, validates and de-duplicates a caller supplied id
// list, preserving the requested order.
func NormalizeInteractionIDs(raw []string) ([]string, error) {
	ids := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, value := range raw {
		id := strings.TrimSpace(value)
		if id == "" {
			continue
		}
		if len(id) > 64 {
			return nil, ErrInvalidInput
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) > MaxInteractionBatch {
		return nil, ErrInvalidInput
	}
	return ids, nil
}

// ValidateInteractionTargetType checks the target type used by the read endpoints.
func ValidateInteractionTargetType(targetType TargetType) error {
	if !targetType.Valid() {
		return ErrInvalidInput
	}
	return nil
}

// ValidateReadingTarget checks a reading history write.
func ValidateReadingTarget(targetType TargetType, targetID string) error {
	if targetType != TargetArticle && targetType != TargetPost {
		return ErrInvalidInput
	}
	if strings.TrimSpace(targetID) == "" || len(targetID) > 64 {
		return ErrInvalidInput
	}
	return nil
}

// NormalizeInteractionLimit clamps a list page size.
func NormalizeInteractionLimit(limit int) int {
	if limit <= 0 || limit > 100 {
		return 20
	}
	return limit
}
