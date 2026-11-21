// Package platformadmin implements the deployment level site console: listing the
// sites of the install, creating a new site together with its first administrator, and
// handing a platform administrator or a site owner over to a site they may manage.
//
// The package is transport agnostic; failures are sentinel errors that the HTTP layer
// maps onto the shared problem+json model.
package platformadmin

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/site"
)

// Sentinel errors returned by the platform console.
var (
	// ErrPermissionDenied means the caller is neither a platform administrator of the
	// site it is connected to nor an administrator of the target site.
	ErrPermissionDenied = errors.New("platform: permission denied")
	// ErrSiteNotFound means the target site does not exist.
	ErrSiteNotFound = errors.New("platform: site not found")
	// ErrSlugTaken means another site already owns the requested slug.
	ErrSlugTaken = errors.New("platform: slug already taken")
	// ErrDomainTaken means another site already owns the requested primary domain.
	ErrDomainTaken = errors.New("platform: domain already taken")
	// ErrInvalidInput means a caller supplied value failed validation.
	ErrInvalidInput = errors.New("platform: invalid input")
	// ErrSwitchTokenInvalid means the handoff token is missing, forged or expired.
	ErrSwitchTokenInvalid = errors.New("platform: invalid site switch token")
	// ErrSwitchNotAllowed means the target site cannot be entered (no domain, an
	// unverified domain, or it has been disabled).
	ErrSwitchNotAllowed = errors.New("platform: site cannot be entered")
	// ErrConsoleSiteNeedsDomain means the site the console is served from has no
	// verified domain. Creating a second site would stop the single-site fallback
	// from resolving, so the console itself would become unreachable.
	ErrConsoleSiteNeedsDomain = errors.New("platform: console site needs a verified domain")
)

// MaxListedSites bounds one page of the console. The platform console is an operator
// screen, not a public listing; a deployment large enough to exceed this needs paging
// rather than a larger in-memory slice.
const MaxListedSites = 100

// DefaultDesignDocument is the design document a newly created site starts with.
//
// It is deliberately tiny: the browser normalises a partial document into the full
// default theme, layout and page set (see web/src/lib/customize.ts). Storing only
// the structural marker and language keeps the server out of the presentation defaults,
// which is what lets the frontend evolve its design model without a server migration.
const DefaultDesignDocument = `{"schema_version":2,"language":"zh-CN"}`

// SiteSummary is one row of the platform site list.
type SiteSummary struct {
	Site site.Site
	// MemberCount is the number of memberships of the site, including suspended ones.
	MemberCount int
	// AdminCount is the number of active members that may administer the site.
	AdminCount int
}

// SiteDetail is a site plus the caller's role on it and its domain challenge state.
//
// The domain status is part of the detail because a freshly created site is not
// reachable by its hostname until the challenge is redeemed: the console is the only
// place that can show the TXT record and trigger verification.
type SiteDetail struct {
	Site   SiteSummary
	Role   site.Role
	Domain site.DomainStatus
}

// OwnerInput is the first administrator account of a newly created site.
type OwnerInput struct {
	Email       string
	DisplayName string
	Password    string
	// ConfirmWeakPassword is the explicit acknowledgement of a weak initial password.
	ConfirmWeakPassword bool
}

// CreateSiteInput describes one site creation.
type CreateSiteInput struct {
	Name        string
	Slug        string
	Description string
	// Domain is the primary hostname. It is required: a site without a hostname cannot
	// be resolved in a multi-site deployment, and this endpoint exists to make sites
	// operational, not just present in the database.
	Domain         string
	VisibilityMode site.VisibilityMode
	PublishMode    site.PublishMode
	Owner          OwnerInput
}

// Entry is the answer to "enter this site".
//
// SwitchToken is present only when Switchable is true. The client hands it to the
// target site's own origin, where Claim redeems it for a normal session: the access
// token of the console's site is never reused against another tenant.
type Entry struct {
	Site        SiteSummary
	Role        site.Role
	Switchable  bool
	Reason      string
	SwitchToken string
	ExpiresAt   time.Time
}

// Reasons reported when a site exists but cannot be entered right now.
const (
	// EntryReasonDomainMissing means the site has no primary domain.
	EntryReasonDomainMissing = "domain_missing"
	// EntryReasonDomainUnverified means the domain exists but has not passed the DNS
	// challenge, so the hostname does not resolve to the site yet.
	EntryReasonDomainUnverified = "domain_unverified"
	// EntryReasonDisabled means the site has been switched off.
	EntryReasonDisabled = "site_disabled"
)

// Defaults applied to an omitted mode.
const (
	defaultPublishMode = site.PublishModeReview
)

// slugPattern accepts the DNS-label style slugs used by seed and by the site settings:
// lowercase letters, digits and inner hyphens.
var slugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)

// normalizeCreate validates and normalises one creation request.
//
// Every check happens before the database is touched: the site row and its first
// administrator are created together, and a validation failure after the row exists
// would leave an unreachable site behind.
func normalizeCreate(in CreateSiteInput) (CreateSiteInput, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return CreateSiteInput{}, formatInvalid("name is required")
	}
	if len([]rune(name)) > 160 {
		return CreateSiteInput{}, formatInvalid("name must be at most 160 characters")
	}

	slug := strings.ToLower(strings.TrimSpace(in.Slug))
	if slug == "" {
		return CreateSiteInput{}, formatInvalid("slug is required")
	}
	if !slugPattern.MatchString(slug) {
		return CreateSiteInput{}, formatInvalid(
			"slug must be 1-64 lowercase letters, digits or inner hyphens")
	}

	domain, err := site.NormalizeDomain(strings.TrimSpace(in.Domain))
	if err != nil {
		return CreateSiteInput{}, wrapInvalid(err)
	}
	if domain == "" {
		return CreateSiteInput{}, formatInvalid("domain is required")
	}

	visibility := in.VisibilityMode
	if visibility == "" {
		visibility = site.VisibilityPublic
	}
	if visibility != site.VisibilityPublic && visibility != site.VisibilityMembersOnly {
		return CreateSiteInput{}, formatInvalid("visibility_mode must be public or members_only")
	}

	publish := in.PublishMode
	if publish == "" {
		publish = defaultPublishMode
	}
	switch publish {
	case site.PublishModeOpen, site.PublishModeReview, site.PublishModeRoleBased:
	default:
		return CreateSiteInput{}, formatInvalid("publish_mode must be open, review or role_based")
	}

	description := strings.TrimSpace(in.Description)
	if len([]rune(description)) > 2000 {
		return CreateSiteInput{}, formatInvalid("description must be at most 2000 characters")
	}

	email, err := auth.NormalizeEmail(in.Owner.Email)
	if err != nil {
		return CreateSiteInput{}, wrapInvalid(err)
	}
	displayName, err := auth.ValidateDisplayName(in.Owner.DisplayName)
	if err != nil {
		return CreateSiteInput{}, wrapInvalid(err)
	}
	if err := auth.ValidatePasswordForCreation(
		in.Owner.Password, in.Owner.ConfirmWeakPassword,
	); err != nil {
		return CreateSiteInput{}, wrapInvalid(err)
	}

	return CreateSiteInput{
		Name:           name,
		Slug:           slug,
		Description:    description,
		Domain:         domain,
		VisibilityMode: visibility,
		PublishMode:    publish,
		Owner: OwnerInput{
			Email:               email,
			DisplayName:         displayName,
			Password:            in.Owner.Password,
			ConfirmWeakPassword: in.Owner.ConfirmWeakPassword,
		},
	}, nil
}

// formatInvalid wraps a validation message so the transport can turn it into a 400.
func formatInvalid(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalidInput, message)
}

// wrapInvalid re-brands a validation failure from a collaborating module (auth input
// rules, domain normalisation) as a platform input failure while keeping the original
// chain: the handler can still recover the field and rule that failed.
func wrapInvalid(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%w: %w", ErrInvalidInput, err)
}
