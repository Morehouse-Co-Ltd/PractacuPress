package site

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Action is a permission checked against a membership.
type Action string

// The permission surface of the first release.
const (
	ActionWriteContent    Action = "content.write"
	ActionModerateContent Action = "content.moderate"
	ActionManageMembers   Action = "site.members.manage"
	ActionManageSite      Action = "site.manage"
)

// Can reports whether a member may perform action.
//
// Authorisation is a single table instead of scattered role comparisons: adding a
// role or an action changes exactly one place, and every call site stays honest.
func Can(member Member, action Action) bool {
	if !member.IsActive() {
		return false
	}

	switch action {
	case ActionWriteContent:
		return member.Role.AtLeast(RoleMember)
	case ActionModerateContent:
		return member.Role.AtLeast(RoleEditor)
	case ActionManageMembers, ActionManageSite:
		return member.Role.AtLeast(RoleSiteAdmin)
	default:
		return false
	}
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
}

// Option configures optional Service behaviour.
type Option func(*Service)

// RequirePublicAddress makes a single site without a domain reachable only through a
// public IP literal.
//
// It exists because the domain-less fallback would otherwise answer on any hostname,
// including localhost and private addresses, which is exactly the accidental exposure
// production must not have. Development, tests and the desktop launcher leave it off.
func RequirePublicAddress(required bool) Option {
	return func(s *Service) { s.requirePublicAddress = required }
}

// NewService builds a Service. Options keep the original NewService(repo) call sites
// working unchanged.
func NewService(repo Repository, opts ...Option) (*Service, error) {
	if repo == nil {
		return nil, errors.New("site: repository is required")
	}
	service := &Service{repo: repo, now: func() time.Time { return time.Now().UTC() }}
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
	if ok && solo.Domain == "" {
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
	// The site must keep at least one platform administrator that can actually log
	// in; otherwise nobody could ever restore the role.
	if target.Role == RolePlatformAdmin && role != RolePlatformAdmin {
		admins, countErr := s.repo.CountMembersByRole(ctx, siteID, RolePlatformAdmin)
		if countErr != nil {
			return countErr
		}
		if admins <= 1 {
			return ErrLastPlatformAdmin
		}
	}

	return s.repo.UpdateMemberRole(ctx, siteID, userID, role, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.member.role_changed",
		Target:    userID,
		RequestID: requestID,
		Detail:    map[string]any{"from": string(target.Role), "to": string(role)},
		At:        s.now(),
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
		Name:           strings.TrimSpace(in.Name),
		Description:    strings.TrimSpace(in.Description),
		VisibilityMode: in.VisibilityMode,
		PublishMode:    in.PublishMode,
	}
	// A domain written through the general settings endpoint is verified exactly like
	// one written through PUT /sites/{id}/domain. Leaving it unverified would make the
	// site unreachable: ValidateForServing rejects an unverified domain.
	if in.Domain != "" {
		domain, domainErr := normalizeDomain(in.Domain)
		if domainErr != nil {
			return domainErr
		}
		normalized.Domain = domain
		if domain != "" {
			verifiedAt := s.now()
			normalized.DomainVerifiedAt = &verifiedAt
		}
	}

	return s.repo.UpdateSettings(ctx, siteID, normalized, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.settings.updated",
		Target:    siteID,
		RequestID: requestID,
		Detail: map[string]any{
			"visibility_mode": string(normalized.VisibilityMode),
			"publish_mode":    string(normalized.PublishMode),
		},
		At: s.now(),
	})
}

// UpdateDomain sets or clears the site's primary domain.
//
// A non-empty domain is treated as operator declared ownership: it is stored together
// with domain_verified_at = now, because an unverified domain would fail
// ValidateForServing and take the site offline. An empty string clears both the domain
// and the verification, which restores the domain-less fallback.
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

	in := DomainInput{Domain: normalized}
	if normalized != "" {
		// The domain index is unique. Checking first gives the caller a 409 instead of
		// a database error; a concurrent write can still lose the race and surface as a
		// constraint failure.
		existing, findErr := s.repo.FindByDomain(ctx, normalized)
		switch {
		case findErr == nil && existing.ID != siteID:
			return ErrDomainTaken
		case findErr == nil:
			// The site already owns this domain.
		case !errors.Is(findErr, ErrNotFound):
			return findErr
		}
		verifiedAt := s.now()
		in.VerifiedAt = &verifiedAt
	}

	return s.repo.UpdateDomain(ctx, siteID, in, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.domain.updated",
		Target:    siteID,
		RequestID: requestID,
		Detail:    map[string]any{"domain": normalized},
		At:        s.now(),
	})
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
