package site

import (
	"context"
	"errors"
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
}

// NewService builds a Service.
func NewService(repo Repository) (*Service, error) {
	if repo == nil {
		return nil, errors.New("site: repository is required")
	}
	return &Service{repo: repo, now: func() time.Time { return time.Now().UTC() }}, nil
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
		return err
	}
	// Demoting a platform administrator is as sensitive as promoting one.
	if target.Role == RolePlatformAdmin && actor.Role != RolePlatformAdmin {
		return ErrPermissionDenied
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
		Domain:         NormalizeHost(in.Domain),
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
