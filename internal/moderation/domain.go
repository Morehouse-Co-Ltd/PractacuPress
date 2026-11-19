// Package moderation owns the report queue: who may file a report, who may act on it,
// and which transitions are legal.
//
// Moderation never changes content directly. It records a decision and the content
// module applies its own state machine, so a report cannot become a second, parallel
// way to publish or hide something.
package moderation

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/site"
)

// TargetType names what a report points at.
type TargetType string

// Supported report targets.
//
// The set is closed on purpose: an arbitrary string would let a client file a report
// that no moderator can ever resolve, and resolve actions could not know which module
// to ask to take the content down.
const (
	TargetArticle TargetType = "article"
	TargetPost    TargetType = "post"
	TargetComment TargetType = "comment"
	TargetUser    TargetType = "user"
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

// Reason is why something was reported.
type Reason string

// Supported report reasons.
const (
	ReasonSpam    Reason = "spam"
	ReasonAbuse   Reason = "abuse"
	ReasonIllegal Reason = "illegal"
	ReasonOther   Reason = "other"
)

// Valid reports whether the reason is defined.
func (r Reason) Valid() bool {
	switch r {
	case ReasonSpam, ReasonAbuse, ReasonIllegal, ReasonOther:
		return true
	default:
		return false
	}
}

// Status is a position in the report workflow.
type Status string

// Report states.
const (
	StatusOpen      Status = "open"
	StatusAssigned  Status = "assigned"
	StatusResolved  Status = "resolved"
	StatusDismissed Status = "dismissed"
)

// Valid reports whether the status is defined.
func (s Status) Valid() bool {
	switch s {
	case StatusOpen, StatusAssigned, StatusResolved, StatusDismissed:
		return true
	default:
		return false
	}
}

// Closed reports whether the report reached a terminal state.
func (s Status) Closed() bool { return s == StatusResolved || s == StatusDismissed }

// Action is what a moderator did when closing a report.
type Action string

// Supported resolution actions.
const (
	// ActionIgnore closes the report without touching the target.
	ActionIgnore Action = "ignore"
	// ActionTakedown hides or archives the reported content.
	ActionTakedown Action = "takedown"
	// ActionBan suspends the reported account.
	ActionBan Action = "ban"
)

// Valid reports whether the action is defined.
func (a Action) Valid() bool {
	switch a {
	case ActionIgnore, ActionTakedown, ActionBan:
		return true
	default:
		return false
	}
}

// Sentinel errors.
var (
	// ErrInvalidInput means a field failed validation.
	ErrInvalidInput = errors.New("moderation: invalid input")
	// ErrNotFound means the report does not exist.
	ErrNotFound = errors.New("moderation: not found")
	// ErrPermissionDenied means the actor may not perform the action.
	ErrPermissionDenied = errors.New("moderation: permission denied")
	// ErrCrossSite means the report belongs to another site.
	ErrCrossSite = errors.New("moderation: cross site access")
	// ErrSelfReport means the reporter targeted its own content.
	ErrSelfReport = errors.New("moderation: cannot report your own content")
	// ErrAlreadyClosed means the report reached a terminal state already.
	ErrAlreadyClosed = errors.New("moderation: report is already closed")
	// ErrNotAssignee means only the assigned moderator may resolve the report.
	ErrNotAssignee = errors.New("moderation: only the assignee may resolve")
	// ErrInvalidTransition means the requested move is not available.
	ErrInvalidTransition = errors.New("moderation: invalid transition")
	// ErrDuplicateReport means the reporter already has an open report for the target.
	ErrDuplicateReport = errors.New("moderation: duplicate report")
	// ErrTargetNotFound means the reported target does not exist on this site.
	ErrTargetNotFound = errors.New("moderation: target not found")
	// ErrActionNotAllowed means the resolution action is unavailable to this actor or
	// this deployment (for example banning without member administration rights).
	ErrActionNotAllowed = errors.New("moderation: action not allowed")
	// ErrRateLimited means the reporter filed too many reports in the window.
	ErrRateLimited = errors.New("moderation: too many reports")
)

// Bounds on caller supplied input.
const (
	// MaxNoteLength bounds the free text explanation.
	MaxNoteLength = 2000
	// MaxTargetIDLength bounds an opaque target id.
	MaxTargetIDLength = 36
)

// Actor is the caller performing a moderation action.
type Actor struct {
	UserID string
	SiteID string
	Role   site.Role
}

// CanModerate reports whether the actor may act on the queue.
func CanModerate(actor Actor) bool { return actor.Role.AtLeast(site.RoleEditor) }

// CanBanTarget reports whether the actor may suspend an account through a report.
//
// Suspension is member administration, so it needs a site administrator; an editor
// may hide content but not lock somebody out of the site.
func CanBanTarget(actor Actor) bool { return actor.Role.AtLeast(site.RoleSiteAdmin) }

// Report is one reported item.
type Report struct {
	ID         string
	SiteID     string
	ReporterID string
	TargetType TargetType
	TargetID   string
	Reason     Reason
	Note       string
	Status     Status
	AssigneeID string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// NewReportInput is a filing request.
type NewReportInput struct {
	TargetType TargetType
	TargetID   string
	Reason     Reason
	Note       string
}

// ValidateReport normalises and validates a filing request.
func ValidateReport(in NewReportInput, reporterID, targetAuthorID string) (NewReportInput, error) {
	in.TargetType = TargetType(strings.TrimSpace(string(in.TargetType)))
	in.TargetID = strings.TrimSpace(in.TargetID)
	in.Note = strings.TrimSpace(in.Note)

	if in.TargetType == "" || !in.TargetType.Valid() {
		return NewReportInput{}, fmt.Errorf("%w: target type is required", ErrInvalidInput)
	}
	if in.TargetID == "" || len(in.TargetID) > MaxTargetIDLength {
		return NewReportInput{}, fmt.Errorf("%w: target id is required", ErrInvalidInput)
	}
	if !in.Reason.Valid() {
		return NewReportInput{}, fmt.Errorf("%w: unknown reason", ErrInvalidInput)
	}
	if len([]rune(in.Note)) > MaxNoteLength {
		return NewReportInput{}, fmt.Errorf("%w: note is too long", ErrInvalidInput)
	}
	// Reporting yourself is either a mistake or an attempt to bury someone else's
	// report in the same queue; both are rejected.
	if targetAuthorID != "" && targetAuthorID == reporterID {
		return NewReportInput{}, ErrSelfReport
	}
	return in, nil
}

// CanAssign reports whether the actor may take ownership of the report.
func (r Report) CanAssign(actor Actor) bool {
	if actor.SiteID != r.SiteID {
		return false
	}
	if !CanModerate(actor) {
		return false
	}
	return !r.Status.Closed()
}

// CanResolve reports whether the actor may close the report.
//
// Only the assignee closes a report: without that, two moderators can contradict each
// other and the audit trail shows both decisions with no tie breaker.
func (r Report) CanResolve(actor Actor) bool {
	if actor.SiteID != r.SiteID {
		return false
	}
	if !CanModerate(actor) {
		return false
	}
	if r.Status.Closed() {
		return false
	}
	if r.AssigneeID == "" {
		// A platform administrator may close an unassigned report; anyone else must
		// claim it first.
		return actor.Role == site.RolePlatformAdmin
	}
	return r.AssigneeID == actor.UserID
}

// Resolve returns the report after a resolution decision.
func (r Report) Resolve(actor Actor, dismiss bool, note string, at time.Time) (Report, error) {
	if r.Status.Closed() {
		return Report{}, ErrAlreadyClosed
	}
	if !r.CanResolve(actor) {
		return Report{}, ErrNotAssignee
	}

	next := StatusResolved
	if dismiss {
		next = StatusDismissed
	}

	updated := r
	updated.Status = next
	updated.UpdatedAt = at
	if trimmed := strings.TrimSpace(note); trimmed != "" {
		updated.Note = trimmed
	}
	return updated, nil
}

// Assign returns the report after the actor claimed it.
func (r Report) Assign(actor Actor, at time.Time) (Report, error) {
	if r.Status.Closed() {
		return Report{}, ErrAlreadyClosed
	}
	if !r.CanAssign(actor) {
		return Report{}, ErrPermissionDenied
	}

	updated := r
	updated.Status = StatusAssigned
	updated.AssigneeID = actor.UserID
	updated.UpdatedAt = at
	return updated, nil
}
