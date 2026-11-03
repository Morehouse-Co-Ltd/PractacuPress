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
)

// Bounds on caller supplied content.
const (
	// MaxCommentLength bounds a comment body, in characters.
	MaxCommentLength = 5000
	// MaxReplyDepth is the deepest allowed reply nesting. Depth 0 is a top level
	// comment, so a depth of 3 means three levels of replies.
	MaxReplyDepth = 3
)

// Actor is the caller performing an interaction.
type Actor struct {
	UserID string
	SiteID string
	Role   site.Role
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
	CreatedAt  time.Time
	UpdatedAt  time.Time
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
		return NewCommentInput{}, fmt.Errorf("%w: unknown target type", ErrInvalidInput)
	}
	if in.TargetID == "" {
		return NewCommentInput{}, fmt.Errorf("%w: target is required", ErrInvalidInput)
	}
	if in.Body == "" {
		return NewCommentInput{}, fmt.Errorf("%w: body is required", ErrInvalidInput)
	}
	if len([]rune(in.Body)) > MaxCommentLength {
		return NewCommentInput{}, fmt.Errorf("%w: body is too long", ErrInvalidInput)
	}
	if in.TargetType == TargetComment && in.ParentID == "" {
		return NewCommentInput{}, fmt.Errorf("%w: reply target is required", ErrInvalidInput)
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
		return 0, ErrDepthExceeded
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
