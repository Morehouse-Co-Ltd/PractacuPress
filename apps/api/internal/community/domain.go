// Package community holds the interaction aggregate: comments, reactions, bookmarks
// and follows.
//
// All of it is idempotent by construction. A like that arrives twice must leave one
// row, and a follow that arrives twice must leave one relationship, because retries
// and impatient double clicks are normal client behaviour, not errors.
package community

import (
	"errors"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// TargetType names what an interaction points at.
type TargetType string

// Supported interaction targets.
const (
	TargetArticle  TargetType = "article"
	TargetPost     TargetType = "post"
	TargetComment  TargetType = "comment"
	TargetUser     TargetType = "user"
)

// Valid reports whether the target type is defined.
func (t TargetType) Valid() bool {
	switch t {
	case TargetArticle, TargetPost, TargetComment, TargetUser:
		return true
	default:
		return false
	}
}

// Comment status values.
const (
	CommentStatusVisible   = "visible"
	CommentStatusHidden    = "hidden"
	CommentStatusDeleted   = "deleted"
	CommentStatusPending   = "pending_review"
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
	ID         string
	SiteID     string
	AuthorID   string
	TargetType TargetType
	TargetID   string
	ParentID   string
	Depth      int
	Body       string
	Status     string
	CreatedAt  time.Time
	UpdatedAt  time.Time
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
		return NewCommentInput{}, errors.New("community: unknown target type")
	}
	if in.TargetID == "" {
		return NewCommentInput{}, errors.New("community: target is required")
	}
	if in.Body == "" {
		return NewCommentInput{}, errors.New("community: body is required")
	}
	if len([]rune(in.Body)) > MaxCommentLength {
		return NewCommentInput{}, errors.New("community: body is too long")
	}
	if in.TargetType == TargetComment && in.ParentID == "" {
		return NewCommentInput{}, errors.New("community: reply target is required")
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
