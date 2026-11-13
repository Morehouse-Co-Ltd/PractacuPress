package site

import (
	"context"
	"errors"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
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
	// ErrInvalidInput means a caller supplied value failed validation.
	ErrInvalidInput = errors.New("site: invalid input")
	// ErrTargetNotFound means the member named by an administration call does not
	// exist on the site. It is distinct from ErrMemberNotFound, which describes the
	// caller: a missing caller is a permission problem (403), while a missing target
	// is a plain not found (404).
	ErrTargetNotFound = errors.New("site: target member not found")
	// ErrEmailTaken means another account already owns the requested email. Email is
	// a login identity, so the address is unique across the whole install.
	ErrEmailTaken = errors.New("site: email already taken")
	// ErrLastPlatformAdmin means the change would leave the site with no platform
	// administrator able to log in. The site could never be recovered afterwards.
	ErrLastPlatformAdmin = errors.New("site: last platform administrator")
	// ErrCannotManageSelf means the caller tried to administer its own account.
	ErrCannotManageSelf = errors.New("site: cannot manage own account")
	// ErrTargetTooPrivileged means the target is not lower ranked than the caller;
	// only platform administrators may manage anyone, and nobody may manage another
	// platform administrator.
	ErrTargetTooPrivileged = errors.New("site: target role is not lower")
	// ErrDomainTaken means another site already owns the requested domain. The unique
	// index on sites.domain would reject it anyway; checking first turns that into a
	// clean 409 instead of a database error.
	ErrDomainTaken = errors.New("site: domain already taken")
	// ErrDomainVerificationFailed means the DNS TXT challenge did not prove ownership
	// of the declared domain. It is a conflict (409), not a validation error: the
	// request was well formed, the world just did not match it yet.
	ErrDomainVerificationFailed = errors.New("site: domain verification failed")
	// ErrCustomizationNotFound means the site has never saved a design document. It is
	// not an error condition for readers: the browser falls back to its own defaults.
	ErrCustomizationNotFound = errors.New("site: customization not found")
	// ErrCustomizationConflict means the stored document changed since the caller last
	// read it, so the write was refused instead of silently overwriting another edit.
	ErrCustomizationConflict = errors.New("site: customization revision conflict")
	// ErrCustomizationTooLarge means the design document exceeds MaxCustomizationBytes.
	ErrCustomizationTooLarge = errors.New("site: customization document too large")
	// ErrSiteConfigNotFound means the site has never saved a site configuration. It is
	// not an error condition for readers: the browser falls back to its defaults.
	ErrSiteConfigNotFound = errors.New("site: config not found")
	// ErrSiteConfigConflict means the stored configuration changed since the caller
	// last read it, so the write was refused instead of silently overwriting an edit
	// made on another device or in another tab.
	ErrSiteConfigConflict = errors.New("site: config revision conflict")
	// ErrSiteConfigTooLarge means the configuration document exceeds MaxSiteConfigBytes.
	ErrSiteConfigTooLarge = errors.New("site: config document too large")
)

// Member is one user's membership of a site.
type Member struct {
	ID          string
	SiteID      string
	UserID      string
	DisplayName string
	// Email is the account's email login identity. It is empty for accounts that
	// only have a provider identity (for example a pure OAuth account).
	Email string
	// Bio and AvatarMediaID are the public profile fields of the account. They are
	// loaded with the membership so the author archive can render them without a
	// second request.
	Bio             string
	AvatarMediaID   string
	Role            Role
	Status          string
	MediaQuotaBytes *int64
	CreatedAt       time.Time
	// GroupKey is the capability group the member belongs to. It is always
	// populated by the store: an unassigned member falls back to the built-in
	// group of its role.
	GroupKey string
	// GroupName is the operator visible label of that group, when one was set.
	GroupName string
	// Permissions is the expanded capability matrix of the group. Nil means the
	// membership was built without persistence (tests, migrations) and the role
	// defaults apply.
	Permissions PermissionSet
	// AdminAccess mirrors the group's "enter the dashboard" switch.
	AdminAccess bool
}

// Allows reports whether the membership's matrix enables capability.
//
// A nil matrix falls back to the server role, which is the behaviour every
// membership had before permission groups existed. An explicit matrix is
// authoritative: a capability switched off in the dashboard is off here too.
func (m Member) Allows(capability Capability) bool {
	if m.Permissions == nil {
		return DefaultCapabilities(m.Role).Allows(capability)
	}
	return m.Permissions.Allows(capability)
}

// QuotaOverride distinguishes an omitted field from an explicit null value.
// Present=false leaves the stored value unchanged; Present=true and Bytes=nil
// clears the override; a non-nil Bytes value sets it.
type QuotaOverride struct {
	Present bool
	Bytes   *int64
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
//
// Domain is only written when non-empty, which keeps the endpoint a partial update;
// writing a domain through settings creates a fresh verification challenge exactly
// like PUT /sites/{id}/domain and never marks it verified.
type SettingsInput struct {
	Name           string
	Description    string
	VisibilityMode VisibilityMode
	PublishMode    PublishMode
	Domain         string
	// DomainToken is the challenge token stored together with Domain. It is empty
	// when the domain is not being changed.
	DomainToken string
	// RegistrationOpen is nil when the caller did not touch the registration switch.
	// A non-nil value is stored as given: there is no default for an explicit update.
	RegistrationOpen *bool
	// CommentsEnabled and CommentsRequireReview are nil when the caller did not touch
	// the comment policy. Non-nil values are stored as given.
	CommentsEnabled       *bool
	CommentsRequireReview *bool
	MediaQuota            QuotaOverride
}

// DomainInput is a primary domain change.
//
// An empty Domain clears the domain, the challenge token and the verification. A
// non-empty Domain stores the domain together with the new challenge Token; VerifiedAt
// is nil for a freshly declared domain and only becomes non-nil when the DNS challenge
// succeeds.
type DomainInput struct {
	Domain     string
	Token      string
	VerifiedAt *time.Time
}

// MemberProfile is a partial update of the account behind a membership.
//
// Nil fields are left unchanged, which is what makes the endpoint a patch rather
// than a replace. Email, when present, is already normalised.
type MemberProfile struct {
	DisplayName *string
	Email       *string
}

// MemberDirectoryFilter narrows the authenticated member directory.
//
// Query matches the display name. After is the opaque position of the last row of
// the previous page; an empty cursor starts at the beginning.
type MemberDirectoryFilter struct {
	SiteID string
	Query  string
	Limit  int
	After  page.Cursor
}

// MemberDirectoryRepository is the optional persistence port behind the member
// directory. It is split from Repository so existing fakes keep compiling.
type MemberDirectoryRepository interface {
	ListMemberDirectory(ctx context.Context, filter MemberDirectoryFilter) ([]Member, error)
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
	// CountAdmins returns how many active members may administer the site.
	//
	// The setup wizard reads this to tell a finished install from a database that
	// was wiped: a site nobody can administer cannot be configured any further.
	CountAdmins(ctx context.Context, siteID string) (int, error)
	// CountMembersByRole returns how many active members of a site hold role.
	//
	// It backs the last platform administrator guard: a role change must not leave
	// a site that no account can administer.
	CountMembersByRole(ctx context.Context, siteID string, role Role) (int, error)
	// UpdateMemberRole changes a role and records the audit entry atomically.
	UpdateMemberRole(ctx context.Context, siteID, userID string, role Role, audit AuditEntry) error
	// UpdateMemberProfile changes the account fields behind a membership and records
	// the audit entry atomically.
	UpdateMemberProfile(ctx context.Context, siteID, userID string, in MemberProfile, audit AuditEntry) error
	// UpdateMemberStatus changes a membership status and records the audit entry.
	UpdateMemberStatus(ctx context.Context, siteID, userID, status string, audit AuditEntry) error
	// UpdateMemberMediaQuota sets or clears a member's storage override and writes the
	// audit entry in the same transaction.
	UpdateMemberMediaQuota(ctx context.Context, siteID, userID string, quota QuotaOverride, audit AuditEntry) error
	// DeleteMember removes the membership and records the audit entry.
	//
	// Only the membership is removed; the account itself, its content and its other
	// site memberships are left untouched, which is what keeps foreign keys valid.
	DeleteMember(ctx context.Context, siteID, userID string, audit AuditEntry) error
	// UpdateSettings changes site settings and records the audit entry atomically.
	UpdateSettings(ctx context.Context, siteID string, in SettingsInput, audit AuditEntry) error
	// UpdateDomain sets or clears the primary domain and its verification timestamp,
	// recording the audit entry atomically.
	UpdateDomain(ctx context.Context, siteID string, in DomainInput, audit AuditEntry) error
	// Customization returns the saved design document of a site.
	Customization(ctx context.Context, siteID string) (Customization, error)
	// SaveCustomization upserts the design document and records the audit entry in the
	// same transaction, refusing the write when the stored revision moved on.
	SaveCustomization(
		ctx context.Context,
		siteID string,
		in CustomizationInput,
		audit AuditEntry,
	) (Customization, error)
	// SiteConfig returns the saved site configuration of a site.
	SiteConfig(ctx context.Context, siteID string) (SiteConfig, error)
	// SaveSiteConfig upserts the site configuration and records the audit entry in the
	// same transaction, refusing the write when the stored revision moved on.
	SaveSiteConfig(
		ctx context.Context,
		siteID string,
		in SiteConfigInput,
		audit AuditEntry,
	) (SiteConfig, error)
}

// Customization is one site's saved design document.
//
// Document is the JSON the browser sent, byte for byte. The API never interprets it:
// the shape belongs to the frontend, and keeping it opaque is what lets the page
// builder evolve without a schema migration every time a block property is added.
type Customization struct {
	Document  []byte
	Revision  int
	UpdatedAt time.Time
}

// CustomizationInput is one write of the design document.
//
// ExpectedRevision is the revision the caller last read. Zero means "no precondition",
// which is what the first save of a fresh install sends.
type CustomizationInput struct {
	Document         []byte
	ExpectedRevision int
}

// SiteConfig is one site's saved runtime configuration.
//
// Document is the JSON the browser sent, byte for byte. Like the design document it is
// opaque to the API on the way to storage: the service validates a known set of fields
// (bounds, the admin path, the loading screen CSS) but never re-encodes the payload, so
// a property added to the frontend does not need an API change. The public projection a
// visitor receives is built from the same bytes (see publicSiteConfigDocument).
type SiteConfig struct {
	Document  []byte
	Revision  int
	UpdatedAt time.Time
}

// SiteConfigInput is one write of the runtime configuration.
//
// ExpectedRevision has the same meaning as in CustomizationInput: the revision the caller
// last read, zero for the first save of a fresh install.
type SiteConfigInput struct {
	Document         []byte
	ExpectedRevision int
}
