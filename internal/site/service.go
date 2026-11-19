package site

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/platform/page"
)

// Action is a permission checked against a membership.
type Action string

// The permission surface of the first release.
const (
	ActionWriteContent     Action = "content.write"
	ActionModerateContent  Action = "content.moderate"
	ActionManageMembers    Action = "site.members.manage"
	ActionManageSite       Action = "site.manage"
	ActionManagePermission Action = "site.permissions.manage"
	ActionViewLog          Action = "site.audit.view"
	ActionComment          Action = "community.comment"
	ActionModerateComment  Action = "community.comment.moderate"
)

// actionCapability maps a server action to the capability that authorizes it.
//
// The matrix is finer grained than the four roles, but every action still has a
// single capability. Keeping the mapping in one table means the role fallback and
// the configurable matrix can never disagree about what an action means.
var actionCapability = map[Action]Capability{
	ActionWriteContent:     CapabilityWriteContent,
	ActionModerateContent:  CapabilityModerateContent,
	ActionManageMembers:    CapabilityManageMember,
	ActionManageSite:       CapabilityManageSite,
	ActionManagePermission: CapabilityManagePermission,
	ActionViewLog:          CapabilityViewLog,
	ActionComment:          CapabilityComment,
	ActionModerateComment:  CapabilityModerateComment,
}

// Can reports whether a member may perform action.
//
// Authorisation is a single table instead of scattered role comparisons: adding a
// role or an action changes exactly one place, and every call site stays honest.
// When the membership carries a permission group matrix it decides; otherwise the
// role defaults apply, so callers that build a Member by hand keep working.
func Can(member Member, action Action) bool {
	if !member.IsActive() {
		return false
	}
	capability, ok := actionCapability[action]
	if !ok {
		return false
	}
	return member.Allows(capability)
}

// CanAssignRole reports whether actor may grant role to someone else.
//
// Only a platform administrator may create or revoke platform administrators;
// otherwise a site administrator could escalate itself out of its own site.
func CanAssignRole(actor Member, role Role) bool {
	if !role.Valid() || !Can(actor, ActionManageMembers) {
		return false
	}
	if role == RolePlatformAdmin {
		return actor.Role == RolePlatformAdmin
	}
	return true
}

// Service implements site resolution and administration.
type Service struct {
	repo Repository
	now  func() time.Time
	// requirePublicAddress restricts the domain-less single-site fallback to public
	// IP literals. It is enabled in production only, so a desktop or development
	// install keeps working on 127.0.0.1.
	requirePublicAddress bool
	// txtLookup resolves the DNS TXT challenge of a domain verification. It is an
	// interface so the network dependency can be replaced in tests.
	txtLookup TXTLookup
	// stepUpHasher hashes the optional dedicated security password of a site.
	// Nil means a deployment where the feature is not wired; setting a password
	// then fails closed with ErrStepUpUnavailable.
	stepUpHasher StepUpPasswordHasher
	// stepUpTokens verifies X-PP-Step-Up grants. Nil means every write after the
	// first one is refused, which is the safe direction.
	stepUpTokens StepUpTokenVerifier
}

// Option configures optional Service behaviour.
type Option func(*Service)

// RequirePublicAddress makes a single site without a domain reachable only through a
// public IP literal.
//
// It exists because the domain-less fallback would otherwise answer on any hostname,
// including localhost and private addresses, which is exactly the accidental exposure
// production must not have. Development, tests and the desktop install leave it off.
func RequirePublicAddress(required bool) Option {
	return func(s *Service) { s.requirePublicAddress = required }
}

// WithTXTLookup replaces the DNS resolver used by VerifyDomain.
//
// The default is net.DefaultResolver. Tests inject a fake so the ownership challenge
// can be exercised without DNS; a nil lookup is ignored so the default stays in place.
func WithTXTLookup(lookup TXTLookup) Option {
	return func(s *Service) {
		if lookup != nil {
			s.txtLookup = lookup
		}
	}
}

// NewService builds a Service. Options keep the original NewService(repo) call sites
// working unchanged.
func NewService(repo Repository, opts ...Option) (*Service, error) {
	if repo == nil {
		return nil, errors.New("site: repository is required")
	}
	service := &Service{
		repo:      repo,
		now:       func() time.Time { return time.Now().UTC() },
		txtLookup: net.DefaultResolver,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(service)
		}
	}
	return service, nil
}

// Resolve maps a request hostname to a site.
//
// Resolution is strict. An unknown host is an error, never a fallback to another
// site, because serving the wrong site leaks content across tenants. The one
// exception is the single site deployment: when exactly one site exists and it has
// no domain configured, it owns every hostname (design §7.4).
func (s *Service) Resolve(ctx context.Context, hostname string) (Site, error) {
	host := NormalizeHost(hostname)
	if host == "" {
		return Site{}, ErrNotFound
	}

	found, err := s.repo.FindByDomain(ctx, host)
	switch {
	case err == nil:
		if validateErr := found.ValidateForServing(host); validateErr != nil {
			return Site{}, validateErr
		}
		return found, nil
	case !errors.Is(err, ErrNotFound):
		return Site{}, err
	}

	solo, ok, err := s.repo.SingleSite(ctx)
	if err != nil {
		return Site{}, err
	}
	if ok {
		switch {
		case solo.Domain == "":
			// Without a domain the site answers on any host, which is convenient for a
			// desktop install but an accidental exposure on a server. Production therefore
			// accepts only public IP literals here; a hostname is what the domain setting
			// is for.
			if s.requirePublicAddress && !isPublicAddress(host) {
				return Site{}, ErrNotFound
			}
			if validateErr := solo.ValidateForServing(host); validateErr != nil {
				return Site{}, validateErr
			}
			return solo, nil

		case solo.DomainVerifiedAt == nil && allowsSetupWindowHost(host):
			// The domain has been declared but its DNS challenge is still pending. The
			// operator has to reach the admin UI to publish the record and verify, so a
			// loopback or IP-literal host keeps resolving to the site until then; every
			// other hostname stays not found, exactly as before. The declared domain
			// itself still answers "unverified", so this is not a bypass for visitors.
			if solo.Disabled {
				return Site{}, ErrDisabled
			}
			return solo, nil
		}
	}

	return Site{}, ErrNotFound
}

// DefaultSite returns the sole site of a single site deployment.
func (s *Service) DefaultSite(ctx context.Context) (Site, error) {
	solo, ok, err := s.repo.SingleSite(ctx)
	if err != nil {
		return Site{}, err
	}
	if !ok {
		return Site{}, ErrNotFound
	}
	if solo.Disabled {
		return Site{}, ErrDisabled
	}
	return solo, nil
}

// PublishMode returns the publishing rule of a site.
//
// It is read on every content write, so it deliberately does no caching: changing
// the mode in the admin UI must take effect on the next request.
func (s *Service) PublishMode(ctx context.Context, siteID string) (PublishMode, error) {
	found, err := s.repo.FindByID(ctx, siteID)
	if err != nil {
		return "", err
	}
	return found.PublishMode, nil
}

// CommentPolicy returns the comment switches of a site.
//
// The community service reads it on every comment write, so a change in the admin UI
// takes effect on the next request and a direct API call cannot bypass it.
func (s *Service) CommentPolicy(ctx context.Context, siteID string) (enabled, requireReview bool, err error) {
	found, err := s.repo.FindByID(ctx, siteID)
	if err != nil {
		return false, false, err
	}
	return found.CommentsEnabled, found.CommentsRequireReview, nil
}

// Get returns a site to a caller who is a member of it.
//
// Non members get ErrMemberNotFound rather than ErrNotFound so the endpoint does not
// double as a site discovery oracle.
func (s *Service) Get(ctx context.Context, siteID, userID string) (Site, error) {
	if _, err := s.Membership(ctx, siteID, userID); err != nil {
		return Site{}, err
	}
	return s.repo.FindByID(ctx, siteID)
}

// Membership returns the actor's membership of a site.
func (s *Service) Membership(ctx context.Context, siteID, userID string) (Member, error) {
	member, err := s.repo.FindMember(ctx, siteID, userID)
	if err != nil {
		return Member{}, err
	}
	if !member.IsActive() {
		return Member{}, ErrMemberNotFound
	}
	return member, nil
}

// ListMembers returns the members of a site.
func (s *Service) ListMembers(ctx context.Context, actor Member, siteID string, limit int) ([]Member, error) {
	if err := authorize(actor, siteID, ActionManageMembers); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	return s.repo.ListMembers(ctx, siteID, limit)
}

// PublicMember returns the author archive profile of one active member.
//
// The caller is not passed in on purpose: the endpoint is public, so the only thing
// that matters is whether the account is an active member of this site. Suspended and
// invited memberships answer not found, exactly like an unknown account, so the
// endpoint cannot be used to enumerate deactivated accounts.
func (s *Service) PublicMember(ctx context.Context, siteID, userID string) (Member, error) {
	member, err := s.repo.FindMember(ctx, siteID, userID)
	if err != nil {
		if errors.Is(err, ErrMemberNotFound) {
			return Member{}, ErrTargetNotFound
		}
		return Member{}, err
	}
	if !member.IsActive() {
		return Member{}, ErrTargetNotFound
	}
	return member, nil
}

// MemberDirectory lists the active members of a site to a signed-in member.
//
// The caller must be an active member of the same site. The result is the public
// profile projection only: no email, status or media quota, because the directory is
// a people finder for the community, not an administration screen.
func (s *Service) MemberDirectory(
	ctx context.Context,
	siteID, actorUserID, query string,
	limit int,
	after page.Cursor,
) ([]Member, page.Cursor, error) {
	if siteID == "" || actorUserID == "" {
		return nil, page.Cursor{}, ErrPermissionDenied
	}
	if _, err := s.Membership(ctx, siteID, actorUserID); err != nil {
		return nil, page.Cursor{}, err
	}

	directory, ok := s.repo.(MemberDirectoryRepository)
	if !ok {
		return nil, page.Cursor{}, errors.New("site: member directory is not configured")
	}
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	filter := MemberDirectoryFilter{
		SiteID: siteID,
		Query:  strings.TrimSpace(query),
		Limit:  limit,
		After:  after,
	}
	members, err := directory.ListMemberDirectory(ctx, filter)
	if err != nil {
		return nil, page.Cursor{}, err
	}

	next := page.Cursor{}
	if len(members) == limit && len(members) > 0 {
		last := members[len(members)-1]
		next = page.Cursor{
			Key: last.CreatedAt.UTC().Format(time.RFC3339Nano),
			ID:  last.UserID,
		}
	}
	return members, next, nil
}

// ChangeMemberRole changes another member's role.
//
// Two escalation guards matter here: the actor must administer this site, and only a
// platform administrator may grant or revoke the platform administrator role.
func (s *Service) ChangeMemberRole(
	ctx context.Context,
	actor Member,
	siteID, userID string,
	role Role,
	requestID string,
) error {
	if err := authorize(actor, siteID, ActionManageMembers); err != nil {
		return err
	}
	if !role.Valid() {
		return ErrInvalidRole
	}
	if !CanAssignRole(actor, role) {
		return ErrPermissionDenied
	}

	target, err := s.repo.FindMember(ctx, siteID, userID)
	if err != nil {
		if errors.Is(err, ErrMemberNotFound) {
			return ErrTargetNotFound
		}
		return err
	}
	// Demoting a platform administrator is as sensitive as promoting one.
	if target.Role == RolePlatformAdmin && actor.Role != RolePlatformAdmin {
		return ErrPermissionDenied
	}
	// The highest administrator seat belongs to the account that registered the
	// site. It cannot be granted to another account, and it cannot be revoked: a
	// no-op (owner to owner) is the only accepted transition, which keeps exactly
	// one known super administrator.
	if (target.Role == RolePlatformAdmin) != (role == RolePlatformAdmin) {
		return ErrPlatformAdminLocked
	}

	return s.repo.UpdateMemberRole(ctx, siteID, userID, role, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.member.role_changed",
		Target:    userID,
		RequestID: requestID,
		Detail: map[string]any{
			"from":  string(target.Role),
			"to":    string(role),
			"group": GroupKeyForRole(role),
		},
		At: s.now(),
	})
}

// UpdateMemberProfile changes the display name or login email of a member.
//
// This is deliberately stricter than a role change: only a platform administrator
// may rewrite an account, and only for a member of lower rank. Editing another
// platform administrator, or the caller itself, stays impossible.
func (s *Service) UpdateMemberProfile(
	ctx context.Context,
	actor Member,
	siteID, userID string,
	in MemberProfile,
	requestID string,
) (Member, error) {
	if err := authorize(actor, siteID, ActionManageMembers); err != nil {
		return Member{}, err
	}
	target, err := s.manageableTarget(ctx, actor, siteID, userID)
	if err != nil {
		return Member{}, err
	}

	profile := MemberProfile{}
	changed := make([]string, 0, 2)
	if in.DisplayName != nil {
		name, nameErr := validateMemberDisplayName(*in.DisplayName)
		if nameErr != nil {
			return Member{}, nameErr
		}
		profile.DisplayName = &name
		changed = append(changed, "display_name")
	}
	if in.Email != nil {
		email, emailErr := normalizeMemberEmail(*in.Email)
		if emailErr != nil {
			return Member{}, emailErr
		}
		// Re-sending the current address is not an update; it must not trip the
		// uniqueness check against the account's own identity.
		if email != target.Email {
			profile.Email = &email
			changed = append(changed, "email")
		}
	}
	if len(changed) == 0 {
		return Member{}, formatInvalid("nothing to update")
	}

	if err := s.repo.UpdateMemberProfile(ctx, siteID, userID, profile, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.member.profile_updated",
		Target:    userID,
		RequestID: requestID,
		Detail:    map[string]any{"fields": changed},
		At:        s.now(),
	}); err != nil {
		return Member{}, err
	}

	if profile.DisplayName != nil {
		target.DisplayName = *profile.DisplayName
	}
	if profile.Email != nil {
		target.Email = *profile.Email
	}
	return target, nil
}

// UpdateMemberStatus suspends or reactivates a member's site membership.
//
// Only the membership status is touched, never the global account: an account can
// belong to several sites, and one site has no business disabling it everywhere.
// Login and refresh both read the membership through FindMembershipRole, which only
// accepts an active membership, so a suspended member cannot obtain a session.
func (s *Service) UpdateMemberStatus(
	ctx context.Context,
	actor Member,
	siteID, userID, status string,
	requestID string,
) (Member, error) {
	if err := authorize(actor, siteID, ActionManageMembers); err != nil {
		return Member{}, err
	}
	if status != MemberStatusActive && status != MemberStatusSuspended {
		return Member{}, formatInvalid("status must be active or suspended")
	}

	target, err := s.manageableTarget(ctx, actor, siteID, userID)
	if err != nil {
		return Member{}, err
	}

	if err := s.repo.UpdateMemberStatus(ctx, siteID, userID, status, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.member.status_changed",
		Target:    userID,
		RequestID: requestID,
		Detail:    map[string]any{"from": target.Status, "to": status},
		At:        s.now(),
	}); err != nil {
		return Member{}, err
	}

	target.Status = status
	return target, nil
}

// UpdateMemberMediaQuota sets or clears one member's media storage override.
//
// Only site administrators may manage quotas. A missing property is a read-only
// no-op and returns the current member so PATCH responses remain useful.
func (s *Service) UpdateMemberMediaQuota(
	ctx context.Context,
	actor Member,
	siteID, userID string,
	quota QuotaOverride,
	requestID string,
) (Member, error) {
	if err := authorize(actor, siteID, ActionManageSite); err != nil {
		return Member{}, err
	}
	target, err := s.repo.FindMember(ctx, siteID, userID)
	if err != nil {
		if errors.Is(err, ErrMemberNotFound) {
			return Member{}, ErrTargetNotFound
		}
		return Member{}, err
	}
	if !quota.Present {
		return target, nil
	}
	if quota.Bytes != nil && *quota.Bytes < 0 {
		return Member{}, ErrInvalidInput
	}
	if err := s.repo.UpdateMemberMediaQuota(ctx, siteID, userID, quota, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.member.media_quota_updated",
		Target:    userID,
		RequestID: requestID,
		Detail:    map[string]any{"media_quota_bytes": quota.Bytes},
		At:        s.now(),
	}); err != nil {
		return Member{}, err
	}
	target.MediaQuotaBytes = quota.Bytes
	return target, nil
}

// DeleteMember removes a member from the site.
//
// The account itself is kept: it may still own content, comments and other site
// memberships, and deleting a user row would either break those references or
// cascade into data loss. Rejoining the site or recreating the account is a
// deliberate future operation, not a side effect of "remove from this site".
func (s *Service) DeleteMember(ctx context.Context, actor Member, siteID, userID, requestID string) error {
	if err := authorize(actor, siteID, ActionManageMembers); err != nil {
		return err
	}
	target, err := s.manageableTarget(ctx, actor, siteID, userID)
	if err != nil {
		return err
	}

	return s.repo.DeleteMember(ctx, siteID, target.UserID, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.member.removed",
		Target:    userID,
		RequestID: requestID,
		Detail:    map[string]any{"role": string(target.Role)},
		At:        s.now(),
	})
}

// manageableTarget loads the member an administration call is aimed at and checks
// that the caller outranks it.
//
// "Lower" is strict: a caller may never edit itself and never another platform
// administrator, so the account operations cannot be used to disable the only other
// administrator or to edit one's own audit trail.
func (s *Service) manageableTarget(ctx context.Context, actor Member, siteID, userID string) (Member, error) {
	if actor.Role != RolePlatformAdmin {
		return Member{}, ErrPermissionDenied
	}

	target, err := s.repo.FindMember(ctx, siteID, userID)
	if err != nil {
		if errors.Is(err, ErrMemberNotFound) {
			return Member{}, ErrTargetNotFound
		}
		return Member{}, err
	}
	if target.UserID == actor.UserID {
		return Member{}, ErrCannotManageSelf
	}
	if target.Role == RolePlatformAdmin {
		return Member{}, ErrTargetTooPrivileged
	}
	return target, nil
}

// formatInvalid wraps a validation message so the transport can turn it into a 400.
func formatInvalid(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalidInput, message)
}

// UpdateSettings changes site level configuration.
//
// Visibility and publish mode are read by every content write, so they are treated
// as privileged: only a site administrator may change them.
//
// A domain written through this endpoint is treated exactly like one written through
// UpdateDomain: it creates a fresh DNS challenge and is never marked verified here.
// Re-sending the current domain is a no-op and keeps its verification state, because
// admin forms commonly submit every field on each save.
func (s *Service) UpdateSettings(
	ctx context.Context,
	actor Member,
	siteID string,
	in SettingsInput,
	requestID string,
) error {
	if err := authorize(actor, siteID, ActionManageSite); err != nil {
		return err
	}

	if in.Name != "" && len(in.Name) > 160 {
		return ErrInvalidInput
	}
	if in.MediaQuota.Present && in.MediaQuota.Bytes != nil && *in.MediaQuota.Bytes < 0 {
		return ErrInvalidInput
	}
	if in.VisibilityMode != "" &&
		in.VisibilityMode != VisibilityPublic && in.VisibilityMode != VisibilityMembersOnly {
		return ErrInvalidInput
	}
	switch in.PublishMode {
	case "", PublishModeOpen, PublishModeReview, PublishModeRoleBased:
	default:
		return ErrInvalidInput
	}

	normalized := SettingsInput{
		Name:                  strings.TrimSpace(in.Name),
		Description:           strings.TrimSpace(in.Description),
		VisibilityMode:        in.VisibilityMode,
		PublishMode:           in.PublishMode,
		RegistrationOpen:      in.RegistrationOpen,
		CommentsEnabled:       in.CommentsEnabled,
		CommentsRequireReview: in.CommentsRequireReview,
		MediaQuota:            in.MediaQuota,
	}
	detail := map[string]any{
		"visibility_mode": string(normalized.VisibilityMode),
		"publish_mode":    string(normalized.PublishMode),
	}
	if in.RegistrationOpen != nil {
		detail["registration_open"] = *in.RegistrationOpen
	}
	if in.CommentsEnabled != nil {
		detail["comments_enabled"] = *in.CommentsEnabled
	}
	if in.CommentsRequireReview != nil {
		detail["comments_require_review"] = *in.CommentsRequireReview
	}
	if in.MediaQuota.Present {
		detail["media_quota_bytes"] = in.MediaQuota.Bytes
	}

	if in.Domain != "" {
		domain, domainErr := normalizeDomain(in.Domain)
		if domainErr != nil {
			return domainErr
		}
		current, findCurrentErr := s.repo.FindByID(ctx, siteID)
		if findCurrentErr != nil {
			return findCurrentErr
		}
		if !strings.EqualFold(current.Domain, domain) {
			// The domain index is unique. Checking first gives the caller a 409 rather
			// than a database error; a concurrent write can still lose the race.
			existing, findErr := s.repo.FindByDomain(ctx, domain)
			switch {
			case findErr == nil && existing.ID != siteID:
				return ErrDomainTaken
			case findErr == nil:
				// This site already owns the value; falling through to a challenge is
				// still correct, a re-declaration restarts verification.
			case !errors.Is(findErr, ErrNotFound):
				return findErr
			}
			if err := s.startDomainChallenge(&normalized, detail, domain); err != nil {
				return err
			}
		}
	}

	return s.repo.UpdateSettings(ctx, siteID, normalized, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.settings.updated",
		Target:    siteID,
		RequestID: requestID,
		Detail:    detail,
		At:        s.now(),
	})
}

// startDomainChallenge fills the domain fields of a settings update with a fresh,
// unverified challenge and documents it in the audit detail.
func (s *Service) startDomainChallenge(normalized *SettingsInput, detail map[string]any, domain string) error {
	token, err := NewDomainVerificationToken()
	if err != nil {
		return err
	}
	normalized.Domain = domain
	normalized.DomainToken = token
	detail["domain"] = domain
	detail["domain_token_set"] = true
	detail["domain_verified"] = false
	return nil
}

// UpdateDomain sets or clears the site's primary domain.
//
// A non-empty domain is only a declaration of intent: it is stored together with a
// freshly generated DNS challenge token and an empty domain_verified_at. Serving on
// that hostname starts only after VerifyDomain proves the TXT record, which is what
// stops any administrator from claiming a hostname they do not control (V-12). An
// empty string clears the domain, the token and the verification, restoring the
// domain-less fallback.
func (s *Service) UpdateDomain(
	ctx context.Context,
	actor Member,
	siteID, domain, requestID string,
) error {
	if err := authorize(actor, siteID, ActionManageSite); err != nil {
		return err
	}

	normalized, err := normalizeDomain(domain)
	if err != nil {
		return err
	}

	// Re-saving the domain that is already verified must be a no-op. A retried form
	// submit used to mint a fresh challenge and clear domain_verified_at, which takes
	// the live hostname offline until the operator republishes the TXT record. A
	// still-unverified declaration may restart the challenge: that is how an operator
	// recovers a lost token.
	current, err := s.repo.FindByID(ctx, siteID)
	if err != nil {
		return err
	}
	if normalized != "" &&
		strings.EqualFold(current.Domain, normalized) &&
		current.DomainVerifiedAt != nil {
		return nil
	}

	in := DomainInput{Domain: normalized}
	detail := map[string]any{
		"domain":           normalized,
		"domain_token_set": false,
		"domain_verified":  false,
	}
	if normalized != "" {
		// The domain index is unique. Checking first gives the caller a 409 instead of
		// a database error; a concurrent write can still lose the race and surface as a
		// constraint failure.
		existing, findErr := s.repo.FindByDomain(ctx, normalized)
		switch {
		case findErr == nil && existing.ID != siteID:
			return ErrDomainTaken
		case findErr == nil:
			// The site already owns this domain; a re-declaration restarts the challenge.
		case !errors.Is(findErr, ErrNotFound):
			return findErr
		}
		token, tokenErr := NewDomainVerificationToken()
		if tokenErr != nil {
			return tokenErr
		}
		in.Token = token
		detail["domain_token_set"] = true
	}

	return s.repo.UpdateDomain(ctx, siteID, in, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.domain.updated",
		Target:    siteID,
		RequestID: requestID,
		// The challenge token itself is never written to the audit log: anyone able to
		// read it could publish the TXT record and claim the domain.
		Detail: detail,
		At:     s.now(),
	})
}

// DomainStatus returns the domain screen state of a site to its manager.
func (s *Service) DomainStatus(ctx context.Context, actor Member, siteID string) (DomainStatus, error) {
	if err := authorize(actor, siteID, ActionManageSite); err != nil {
		return DomainStatus{}, err
	}
	found, err := s.repo.FindByID(ctx, siteID)
	if err != nil {
		return DomainStatus{}, err
	}
	return domainStatusOf(found), nil
}

// VerifyDomain runs the DNS TXT challenge and marks the domain verified on success.
//
// The challenge is checked against the stored token only, never against a value from
// the request: the client cannot choose what would prove ownership. A successful
// re-check of an already verified domain is idempotent.
func (s *Service) VerifyDomain(
	ctx context.Context,
	actor Member,
	siteID, requestID string,
) (DomainStatus, error) {
	if err := authorize(actor, siteID, ActionManageSite); err != nil {
		return DomainStatus{}, err
	}
	found, err := s.repo.FindByID(ctx, siteID)
	if err != nil {
		return DomainStatus{}, err
	}
	if found.Domain == "" {
		return DomainStatus{}, formatInvalid("no domain is configured")
	}
	if found.DomainVerified() {
		return domainStatusOf(found), nil
	}
	if found.DomainVerificationToken == "" {
		// A row from before the challenge existed: declaring the domain again mints a
		// token. This is a validation failure of the current state, not a DNS failure.
		return DomainStatus{}, formatInvalid("no verification challenge is pending; save the domain again")
	}

	recordName := DomainVerificationRecordName(found.Domain)
	lookupCtx, cancel := context.WithTimeout(ctx, domainVerificationLookupTimeout)
	defer cancel()
	records, lookupErr := s.txtLookup.LookupTXT(lookupCtx, recordName)
	if lookupErr != nil {
		return DomainStatus{}, fmt.Errorf("%w: lookup %s: %w", ErrDomainVerificationFailed, recordName, lookupErr)
	}
	if !matchesDomainChallenge(records, found.DomainVerificationToken) {
		return DomainStatus{}, fmt.Errorf(
			"%w: no TXT value at %s matches the challenge", ErrDomainVerificationFailed, recordName)
	}

	now := s.now()
	if err := s.repo.UpdateDomain(ctx, siteID, DomainInput{
		Domain:     found.Domain,
		Token:      found.DomainVerificationToken,
		VerifiedAt: &now,
	}, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.domain.verified",
		Target:    siteID,
		RequestID: requestID,
		Detail:    map[string]any{"domain": found.Domain, "record_name": recordName},
		At:        now,
	}); err != nil {
		return DomainStatus{}, err
	}

	verified := found
	verified.DomainVerifiedAt = &now
	return domainStatusOf(verified), nil
}

// VerifyDomainForPlatform runs the DNS challenge of a site on behalf of the platform
// console.
//
// The console has already authorised the caller as a deployment level platform
// administrator or as the target site's own administrator; the synthetic membership is
// only the shape the site rules expect. Sharing VerifyDomain means the challenge token,
// DNS lookup, audit entry and verified timestamp follow exactly one implementation.
func (s *Service) VerifyDomainForPlatform(
	ctx context.Context,
	siteID, userID string,
) (DomainStatus, error) {
	return s.VerifyDomain(ctx, Member{
		UserID: userID,
		SiteID: siteID,
		Role:   RolePlatformAdmin,
		Status: MemberStatusActive,
	}, siteID, "")
}

// RegistrationOpen reports whether anonymous visitors may create an account on the
// site. The auth service reads it before accepting a registration; an unknown site is
// an error so the caller can refuse instead of defaulting to open.
func (s *Service) RegistrationOpen(ctx context.Context, siteID string) (bool, error) {
	found, err := s.repo.FindByID(ctx, siteID)
	if err != nil {
		return false, err
	}
	return found.RegistrationOpen, nil
}

// authorize rejects a member that may not act on this site.
//
// The site check is separate from the permission check on purpose: a site
// administrator of site A must not administer site B, even with the same role.
func authorize(actor Member, siteID string, action Action) error {
	if actor.SiteID != siteID {
		return ErrCrossSite
	}
	if !Can(actor, action) {
		return ErrPermissionDenied
	}
	return nil
}

// NormalizeHost lowercases and trims a hostname so comparisons are stable.
func NormalizeHost(host string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
}
