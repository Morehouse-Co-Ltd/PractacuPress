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

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

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

// Report is one reported item.
type Report struct {
	ID         string
	SiteID     string
	ReporterID string
	TargetType string
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
	TargetType string
	TargetID   string
	Reason     Reason
	Note       string
}

// ValidateReport normalises and validates a filing request.
func ValidateReport(in NewReportInput, reporterID, targetAuthorID string) (NewReportInput, error) {
	in.TargetType = strings.TrimSpace(in.TargetType)
	in.TargetID = strings.TrimSpace(in.TargetID)
	in.Note = strings.TrimSpace(in.Note)

	if in.TargetType == "" {
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
