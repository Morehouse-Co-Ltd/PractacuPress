// Package site holds the site aggregate: one isolated website with its own
// members, content, publishing rules and visibility.
//
// The package is transport agnostic. It reports failures with sentinel errors;
// mapping those onto HTTP status codes is the transport layer's job.
package site

import (
	"errors"
	"net"
	"strings"
	"time"
)

// Sentinel errors returned by site resolution.
var (
	// ErrNotFound means no site owns the requested host. Unknown hosts must not
	// silently fall back to another site.
	ErrNotFound = errors.New("site: not found")
	// ErrDomainUnverified means the site exists but its hostname has not been
	// proven to belong to it (design §7.4).
	ErrDomainUnverified = errors.New("site: domain unverified")
	// ErrDisabled means the site exists but serving has been switched off.
	ErrDisabled = errors.New("site: disabled")
)

// Role is one of the four fixed roles (design §3).
type Role string

// The four fixed roles.
const (
	RolePlatformAdmin Role = "platform_admin"
	RoleSiteAdmin     Role = "site_admin"
	RoleEditor        Role = "editor"
	RoleMember        Role = "member"
)

// Authority ranks roles so a permission check is one integer comparison instead
// of a web of booleans. Unknown roles rank below a member and therefore grant
// nothing.
func (r Role) Authority() int {
	switch r {
	case RolePlatformAdmin:
		return 40
	case RoleSiteAdmin:
		return 30
	case RoleEditor:
		return 20
	case RoleMember:
		return 10
	default:
		return 0
	}
}

// AtLeast reports whether r has at least the authority of other.
func (r Role) AtLeast(other Role) bool { return r.Authority() >= other.Authority() }

// Valid reports whether r is one of the four defined roles.
func (r Role) Valid() bool { return r.Authority() > 0 }

// VisibilityMode decides who may read a site's content.
type VisibilityMode string

// Visibility modes.
const (
	VisibilityPublic      VisibilityMode = "public"
	VisibilityMembersOnly VisibilityMode = "members_only"
)

// PublishMode decides how content reaches published state.
type PublishMode string

// Publish modes.
const (
	PublishModeOpen      PublishMode = "open"
	PublishModeReview    PublishMode = "review"
	PublishModeRoleBased PublishMode = "role_based"
)

// Site is one isolated website.
type Site struct {
	ID          string
	Slug        string
	Name        string
	Domain      string
	Description string
	// DomainVerificationToken is the challenge an operator publishes as a DNS TXT
	// record to prove the domain belongs to this site. It is only meaningful while
	// DomainVerifiedAt is nil.
	DomainVerificationToken string
	// DomainVerifiedAt is nil until the hostname is proven to belong to the site.
	DomainVerifiedAt *time.Time
	VisibilityMode   VisibilityMode
	PublishMode      PublishMode
	// RegistrationOpen controls whether anonymous visitors may create an account on
	// this site. It is an anti-abuse switch for public sites; the first account of a
	// desktop install is the bootstrap administrator and is not governed by it.
	RegistrationOpen bool
	// CommentsEnabled closes new comment writes when false. CommentsRequireReview
	// routes new comments to pending_review instead of visible. Both are enforced by
	// the community service, so a direct API call obeys the same policy as the UI.
	CommentsEnabled       bool
	CommentsRequireReview bool
	MediaQuotaBytes       *int64
	Disabled              bool
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

// DomainVerified reports whether the site's domain may be served.
func (s Site) DomainVerified() bool { return s.Domain != "" && s.DomainVerifiedAt != nil }

// ValidateForServing returns the reason this site must not serve the given host,
// or nil when it may.
//
// The check is deliberately strict: an unverified or mismatched host is a hard
// failure rather than a fallback, because silently serving the wrong site leaks
// another site's content.
//
// A site that declared a domain but has not verified it yet answers
// ErrDomainUnverified for that host. The operator still reaches it through a loopback
// or IP-literal host during the setup window; that exception lives in Service.Resolve,
// which knows whether a single site deployment can identify the site from such a host.
func (s Site) ValidateForServing(host string) error {
	if s.Disabled {
		return ErrDisabled
	}
	if s.Domain == "" {
		return nil
	}
	if !strings.EqualFold(normalizeHost(s.Domain), normalizeHost(host)) {
		return ErrNotFound
	}
	if s.DomainVerifiedAt == nil {
		return ErrDomainUnverified
	}
	return nil
}

// allowsSetupWindowHost reports whether host may reach a site whose declared domain is
// still unverified.
//
// The setup window exists so the operator can finish the DNS challenge from the machine
// running the site: loopback names and bare IP literals cannot be claimed by a third
// party through DNS, so they are the safe fallback while the domain is unproven. Every
// other hostname is refused until verification succeeds.
func allowsSetupWindowHost(host string) bool {
	normalized := normalizeHost(host)
	if normalized == "localhost" {
		return true
	}
	return net.ParseIP(normalized) != nil
}

// IsMembersOnly reports whether anonymous reads must be refused.
func (s Site) IsMembersOnly() bool { return s.VisibilityMode == VisibilityMembersOnly }

func normalizeHost(host string) string {
	return strings.TrimSuffix(strings.TrimSpace(host), ".")
}
