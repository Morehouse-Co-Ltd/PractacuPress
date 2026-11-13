package platformadmin

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// SiteRecord is everything needed to insert a site and its initial design document.
type SiteRecord struct {
	Name                  string
	Slug                  string
	Description           string
	Domain                string
	DomainToken           string
	VisibilityMode        site.VisibilityMode
	PublishMode           site.PublishMode
	RegistrationOpen      bool
	CommentsEnabled       bool
	CommentsRequireReview bool
	// DesignDocument is the initial design document. It is written in the same
	// transaction as the site, so no site ever exists without a design row.
	DesignDocument []byte
}

// Repository is the persistence contract of the platform console.
//
// It is a separate interface from site.Repository on purpose: creating a site and
// granting its first administrator are platform operations, not site administration,
// and the site module's own persistence port stays free of them.
type Repository interface {
	// CreateSite inserts the site and its initial design document in one transaction.
	// A duplicate slug or domain is reported as ErrSlugTaken / ErrDomainTaken.
	CreateSite(ctx context.Context, in SiteRecord) (site.Site, error)
	// DeleteSite removes a site and the rows created together with it. It is the
	// compensation step when provisioning the first administrator fails.
	DeleteSite(ctx context.Context, siteID string) error
	// FindSite loads one site.
	FindSite(ctx context.Context, siteID string) (site.Site, error)
	// ListSites returns sites ordered by creation time.
	ListSites(ctx context.Context, limit int) ([]site.Site, error)
	// SlugTaken reports whether another site owns slug.
	SlugTaken(ctx context.Context, slug string) (bool, error)
	// DomainTaken reports whether another site owns domain.
	DomainTaken(ctx context.Context, domain string) (bool, error)
	// FindMember returns one membership.
	FindMember(ctx context.Context, siteID, userID string) (site.Member, error)
	// CountMembers returns how many memberships a site has.
	CountMembers(ctx context.Context, siteID string) (int, error)
	// CountAdmins returns how many active members may administer a site.
	CountAdmins(ctx context.Context, siteID string) (int, error)
	// EnsureMember makes userID an active member of siteID with role, creating the
	// membership when it is missing and reactivating it when it was suspended. The
	// audit entry is written in the same transaction.
	EnsureMember(ctx context.Context, siteID, userID string, role site.Role, audit site.AuditEntry) error
	// RecordAudit appends one audit entry.
	RecordAudit(ctx context.Context, audit site.AuditEntry) error
}

// AccountProvisioner creates the first administrator of a newly created site.
//
// It is implemented by auth.Service, which owns password hashing and login identity
// uniqueness. The platform service authorises the caller before calling it; the
// provisioner itself performs no actor check because there is no membership on the new
// site yet.
type AccountProvisioner interface {
	ProvisionSiteOwner(ctx context.Context, siteID string, in auth.CreateMemberInput) (auth.UserView, error)
}

// SessionIssuer mints a session for an account that has just redeemed a handoff token.
//
// It is implemented by auth.Service so the platform console reuses the exact refresh,
// CSRF and access-token rules of a password login.
type SessionIssuer interface {
	IssueSwitchSession(ctx context.Context, siteID, userID string, meta auth.ClientMeta) (auth.Session, error)
}

// SwitchTokenIssuer signs and verifies the short-lived site handoff token.
type SwitchTokenIssuer interface {
	IssueSiteSwitch(userID, siteID string) (string, time.Time, error)
	VerifySiteSwitch(raw string) (userID, siteID string, err error)
}

// DomainVerifier redeems a site's DNS ownership challenge on behalf of the console.
//
// It is implemented by site.Service. The platform service has already checked that the
// caller is a platform administrator or the target site's own administrator, so the
// verifier only reuses the DNS challenge implementation.
type DomainVerifier interface {
	VerifyDomainForPlatform(ctx context.Context, siteID, userID string) (site.DomainStatus, error)
}

// MetricsRepository reads the counters of the whole deployment.
//
// One method, because the console asks one question: the site inventory, its member and
// content counts, the moderation backlog and the recent activity of every site inside
// one window. Storage may implement it with as many queries as it needs; the service
// owns what the numbers mean.
type MetricsRepository interface {
	Metrics(ctx context.Context, since time.Time) (DeploymentMetrics, error)
}

// DirectoryRepository reads accounts across sites.
//
// It is read only by construction: the directory exists to answer "who is on this
// install", not to become a second member administration path. Role and status changes
// stay in the site module, where their audit and membership rules already live.
type DirectoryRepository interface {
	ListAccounts(
		ctx context.Context,
		query AccountQuery,
		limit int,
		after page.Cursor,
	) ([]AccountSummary, string, error)
}

// AuditRepository is the cross-site read side of the audit trail.
//
// It is a superset of the per-site query: the site filter is optional, so one call
// answers both "this site's trail" and "the deployment's trail". auditstore.Store
// implements it beside the site scoped List.
type AuditRepository interface {
	ListAll(
		ctx context.Context,
		filter audit.Filter,
		limit int,
		after page.Cursor,
	) ([]audit.Log, string, error)
}
