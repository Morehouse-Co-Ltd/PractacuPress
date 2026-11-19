// Package audit owns the read side of the audit trail.
//
// Every module writes audit_logs rows inside the transaction of the change it
// describes; this package is the one place that reads them back for the admin
// activity page. Keeping the query here (rather than in each module) gives the
// page one stable filter vocabulary that matches the persisted columns.
package audit

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
)

// Sentinel errors.
var (
	// ErrPermissionDenied means the caller may not read this site's audit trail.
	// Reading it is site administration, not ordinary membership.
	ErrPermissionDenied = errors.New("audit: permission denied")
	// ErrInvalidFilter means a filter value cannot be honoured.
	ErrInvalidFilter = errors.New("audit: invalid filter")
)

// Bounds on filter input.
const (
	// DefaultLimit is the page size when the caller does not ask for one.
	DefaultLimit = 50
	// MaxLimit is the largest page the API hands out.
	MaxLimit = 100
	// MaxActionLength matches audit_logs.action (VARCHAR 120).
	MaxActionLength = 120
	// MaxTargetTypeLength matches audit_logs.target_type (VARCHAR 40).
	MaxTargetTypeLength = 40
	// MaxOutcomeLength matches audit_logs.outcome (VARCHAR 20).
	MaxOutcomeLength = 20
	// MaxIDLength matches the UUID columns these filters compare against.
	MaxIDLength = 36
)

// Entry is one audit row to append.
//
// It mirrors the persisted columns rather than the richer site.AuditEntry so a
// module can record events that are not tied to a site membership (login, email
// verification) without pretending every actor has a target type.
type Entry struct {
	SiteID     string
	ActorID    string
	Action     string
	TargetType string
	TargetID   string
	RequestID  string
	Outcome    string
	Detail     map[string]any
	At         time.Time
}

// Recorder appends audit entries. Implementations must never rewrite history.
type Recorder interface {
	Record(ctx context.Context, entry Entry) error
}

// Log is one row as returned to the activity page.
type Log struct {
	ID         string
	SiteID     string
	ActorID    string
	ActorName  string
	Action     string
	TargetType string
	TargetID   string
	TargetName string
	RequestID  string
	Outcome    string
	Detail     map[string]any
	CreatedAt  time.Time
}

// Filter is the query vocabulary of the activity page.
//
// Empty fields are not applied. From and To are inclusive.
type Filter struct {
	SiteID     string
	From       *time.Time
	To         *time.Time
	ActorID    string
	Action     string
	TargetType string
	TargetID   string
	Outcome    string
}

// Page is one page of audit rows plus the cursor for the next page.
type Page struct {
	Items      []Log
	NextCursor string
}

// Repository is the persistence port. The cursor position is (created_at, id),
// which is stable when several rows share a timestamp.
type Repository interface {
	List(ctx context.Context, filter Filter, limit int, after page.Cursor) ([]Log, string, error)
}

// Service implements the audit query use case.
type Service struct {
	repo Repository
}

// NewService builds a Service.
func NewService(repo Repository) (*Service, error) {
	if repo == nil {
		return nil, errors.New("audit: repository is required")
	}
	return &Service{repo: repo}, nil
}

// List returns one page of a site's audit trail.
//
// Authorization is site administration (site_admin or platform_admin) on the
// exact site the caller is authenticated for: the site id in the path must never
// be allowed to widen a tenant boundary.
func (s *Service) List(
	ctx context.Context,
	actor site.Member,
	siteID string,
	filter Filter,
	limit int,
	after page.Cursor,
) (Page, error) {
	if actor.SiteID != siteID || !site.Can(actor, site.ActionManageSite) {
		return Page{}, ErrPermissionDenied
	}

	normalized, err := normalizeFilter(filter, siteID)
	if err != nil {
		return Page{}, err
	}
	if limit <= 0 || limit > MaxLimit {
		limit = DefaultLimit
	}
	if !after.IsZero() {
		if _, parseErr := time.Parse(time.RFC3339Nano, after.Key); parseErr != nil {
			return Page{}, ErrInvalidFilter
		}
	}

	items, next, err := s.repo.List(ctx, normalized, limit, after)
	if err != nil {
		return Page{}, err
	}
	return Page{Items: items, NextCursor: next}, nil
}

// normalizeFilter trims and bounds every caller supplied value.
func normalizeFilter(filter Filter, siteID string) (Filter, error) {
	filter.SiteID = siteID
	filter.ActorID = trim(filter.ActorID)
	filter.Action = trim(filter.Action)
	filter.TargetType = trim(filter.TargetType)
	filter.TargetID = trim(filter.TargetID)
	filter.Outcome = trim(filter.Outcome)

	if len(filter.ActorID) > MaxIDLength ||
		len(filter.TargetID) > MaxIDLength ||
		len(filter.Action) > MaxActionLength ||
		len(filter.TargetType) > MaxTargetTypeLength ||
		len(filter.Outcome) > MaxOutcomeLength {
		return Filter{}, ErrInvalidFilter
	}
	if filter.From != nil && filter.To != nil && filter.From.After(*filter.To) {
		return Filter{}, ErrInvalidFilter
	}
	return filter, nil
}

func trim(value string) string {
	return strings.TrimSpace(value)
}
