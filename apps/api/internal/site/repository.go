package site

import (
	"context"
	"errors"
	"time"
)

// Sentinel errors for the site module.
var (
	// ErrMemberNotFound means the account is not a member of the site.
	ErrMemberNotFound = errors.New("site: member not found")
	// ErrPermissionDenied means the actor may not perform the action.
	ErrPermissionDenied = errors.New("site: permission denied")
	// ErrInvalidRole means a role outside the four fixed roles was requested.
	ErrInvalidRole = errors.New("site: invalid role")
	// ErrCrossSite means the actor tried to act on a site it does not administer.
	ErrCrossSite = errors.New("site: cross site access")
	// ErrInvalidInput means a settings value failed validation.
	ErrInvalidInput = errors.New("site: invalid input")
)

// Member is one user's membership of a site.
type Member struct {
	ID          string
	SiteID      string
	UserID      string
	DisplayName string
	Role        Role
	Status      string
	CreatedAt   time.Time
}

// IsActive reports whether the membership may be used.
func (m Member) IsActive() bool { return m.Status == MemberStatusActive }

// SiteMemberStatus values.
const (
	MemberStatusActive    = "active"
	MemberStatusInvited   = "invited"
	MemberStatusSuspended = "suspended"
)

// AuditEntry is a privileged action recorded alongside the change it describes.
type AuditEntry struct {
	SiteID    string
	ActorID   string
	Action    string
	Target    string
	RequestID string
	Detail    map[string]any
	At        time.Time
}

// SettingsInput carries the site settings a manager may change.
type SettingsInput struct {
	Name           string
	Description    string
	VisibilityMode VisibilityMode
	PublishMode    PublishMode
	Domain         string
}

// Repository is the persistence contract for the site module.
type Repository interface {
	// FindByDomain returns the site whose verified domain matches hostname.
	FindByDomain(ctx context.Context, hostname string) (Site, error)
	// FindByID returns a site by id.
	FindByID(ctx context.Context, siteID string) (Site, error)
	// SingleSite returns the only site when exactly one exists, which is how the
	// Windows single site deployment is recognised.
	SingleSite(ctx context.Context) (Site, bool, error)
	// FindMember returns a membership on a site.
	FindMember(ctx context.Context, siteID, userID string) (Member, error)
	// ListMembers returns members ordered by creation time.
	ListMembers(ctx context.Context, siteID string, limit int) ([]Member, error)
	// UpdateMemberRole changes a role and records the audit entry atomically.
	UpdateMemberRole(ctx context.Context, siteID, userID string, role Role, audit AuditEntry) error
	// UpdateSettings changes site settings and records the audit entry atomically.
	UpdateSettings(ctx context.Context, siteID string, in SettingsInput, audit AuditEntry) error
}
