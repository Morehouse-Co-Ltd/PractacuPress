package site

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeRepo is an in memory site.Repository for the service tests.
type fakeRepo struct {
	sites       []Site
	members     map[string]Member
	roleUpdates int
	audits      []AuditEntry
	settings    *SettingsInput
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{members: make(map[string]Member)}
}

func memberKey(siteID, userID string) string { return siteID + "/" + userID }

func (f *fakeRepo) FindByDomain(_ context.Context, hostname string) (Site, error) {
	for _, candidate := range f.sites {
		if candidate.Domain != "" && NormalizeHost(candidate.Domain) == hostname {
			return candidate, nil
		}
	}
	return Site{}, ErrNotFound
}

func (f *fakeRepo) FindByID(_ context.Context, siteID string) (Site, error) {
	for _, candidate := range f.sites {
		if candidate.ID == siteID {
			return candidate, nil
		}
	}
	return Site{}, ErrNotFound
}

func (f *fakeRepo) SingleSite(_ context.Context) (Site, bool, error) {
	if len(f.sites) != 1 {
		return Site{}, false, nil
	}
	return f.sites[0], true, nil
}

func (f *fakeRepo) FindMember(_ context.Context, siteID, userID string) (Member, error) {
	if member, ok := f.members[memberKey(siteID, userID)]; ok {
		return member, nil
	}
	return Member{}, ErrMemberNotFound
}

func (f *fakeRepo) ListMembers(_ context.Context, siteID string, _ int) ([]Member, error) {
	out := make([]Member, 0, len(f.members))
	for _, member := range f.members {
		if member.SiteID == siteID {
			out = append(out, member)
		}
	}
	return out, nil
}

func (f *fakeRepo) UpdateMemberRole(_ context.Context, siteID, userID string, role Role, audit AuditEntry) error {
	key := memberKey(siteID, userID)
	member, ok := f.members[key]
	if !ok {
		return ErrMemberNotFound
	}
	member.Role = role
	f.members[key] = member
	f.roleUpdates++
	f.audits = append(f.audits, audit)
	return nil
}

func (f *fakeRepo) UpdateSettings(_ context.Context, _ string, in SettingsInput, audit AuditEntry) error {
	f.settings = &in
	f.audits = append(f.audits, audit)
	return nil
}

func activeMember(siteID, userID string, role Role) Member {
	return Member{
		ID: "member_" + userID, SiteID: siteID, UserID: userID,
		Role: role, Status: MemberStatusActive, CreatedAt: time.Now().UTC(),
	}
}

func newService(t *testing.T, repo Repository) *Service {
	t.Helper()
	service, err := NewService(repo)
	require.NoError(t, err)
	return service
}

func TestNewServiceRequiresRepository(t *testing.T) {
	_, err := NewService(nil)
	require.Error(t, err)
}

func TestResolveVerifiedDomain(t *testing.T) {
	verified := time.Now().UTC()
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1", Domain: "example.com", DomainVerifiedAt: &verified}}

	found, err := newService(t, repo).Resolve(context.Background(), "EXAMPLE.com.")
	require.NoError(t, err)
	require.Equal(t, "s1", found.ID)
}

func TestResolveUnverifiedDomainIsRefused(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1", Domain: "example.com"}}

	_, err := newService(t, repo).Resolve(context.Background(), "example.com")
	require.ErrorIs(t, err, ErrDomainUnverified)
}

func TestResolveDisabledSiteIsRefused(t *testing.T) {
	verified := time.Now().UTC()
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1", Domain: "example.com", DomainVerifiedAt: &verified, Disabled: true}}

	_, err := newService(t, repo).Resolve(context.Background(), "example.com")
	require.ErrorIs(t, err, ErrDisabled)
}

// TestResolveUnknownHostNeverFallsBack is the multi tenant safety property: with
// more than one site, an unknown host must be an error, not the first site.
func TestResolveUnknownHostNeverFallsBack(t *testing.T) {
	verified := time.Now().UTC()
	repo := newFakeRepo()
	repo.sites = []Site{
		{ID: "s1", Domain: "a.example.com", DomainVerifiedAt: &verified},
		{ID: "s2", Domain: "b.example.com", DomainVerifiedAt: &verified},
	}

	_, err := newService(t, repo).Resolve(context.Background(), "unknown.example.com")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestResolveSingleSiteWithoutDomainOwnsEveryHost(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "only"}}

	found, err := newService(t, repo).Resolve(context.Background(), "127.0.0.1")
	require.NoError(t, err)
	require.Equal(t, "only", found.ID)
}

func TestResolveSingleSiteWithDomainStillRejectsForeignHost(t *testing.T) {
	verified := time.Now().UTC()
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "only", Domain: "example.com", DomainVerifiedAt: &verified}}

	_, err := newService(t, repo).Resolve(context.Background(), "evil.test")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestResolveEmptyHost(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "only"}}

	_, err := newService(t, repo).Resolve(context.Background(), "   ")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestDefaultSite(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)

	_, err := service.DefaultSite(context.Background())
	require.ErrorIs(t, err, ErrNotFound)

	repo.sites = []Site{{ID: "only"}}
	found, err := service.DefaultSite(context.Background())
	require.NoError(t, err)
	require.Equal(t, "only", found.ID)
}

// TestCanMatrix pins the whole permission table in one place.
func TestCanMatrix(t *testing.T) {
	cases := []struct {
		role   Role
		action Action
		want   bool
	}{
		{RolePlatformAdmin, ActionManageSite, true},
		{RolePlatformAdmin, ActionManageMembers, true},
		{RolePlatformAdmin, ActionModerateContent, true},
		{RolePlatformAdmin, ActionWriteContent, true},

		{RoleSiteAdmin, ActionManageSite, true},
		{RoleSiteAdmin, ActionManageMembers, true},
		{RoleSiteAdmin, ActionModerateContent, true},
		{RoleSiteAdmin, ActionWriteContent, true},

		{RoleEditor, ActionManageSite, false},
		{RoleEditor, ActionManageMembers, false},
		{RoleEditor, ActionModerateContent, true},
		{RoleEditor, ActionWriteContent, true},

		{RoleMember, ActionManageSite, false},
		{RoleMember, ActionManageMembers, false},
		{RoleMember, ActionModerateContent, false},
		{RoleMember, ActionWriteContent, true},
	}

	for _, tc := range cases {
		member := activeMember("s1", "u1", tc.role)
		require.Equal(t, tc.want, Can(member, tc.action), "%s/%s", tc.role, tc.action)
	}
}

func TestCanRejectsInactiveMembers(t *testing.T) {
	member := activeMember("s1", "u1", RoleSiteAdmin)
	member.Status = MemberStatusSuspended
	require.False(t, Can(member, ActionManageSite))
}

func TestCanAssignRole(t *testing.T) {
	siteAdmin := activeMember("s1", "admin", RoleSiteAdmin)
	platformAdmin := activeMember("s1", "root", RolePlatformAdmin)

	require.True(t, CanAssignRole(siteAdmin, RoleEditor))
	require.True(t, CanAssignRole(siteAdmin, RoleMember))
	require.False(t, CanAssignRole(siteAdmin, RolePlatformAdmin),
		"a site admin must not be able to create a platform admin")
	require.True(t, CanAssignRole(platformAdmin, RolePlatformAdmin))
	require.False(t, CanAssignRole(siteAdmin, Role("superuser")))
	require.False(t, CanAssignRole(activeMember("s1", "m", RoleMember), RoleEditor))
}

func TestChangeMemberRoleHappyPathWritesAudit(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	repo.members[memberKey("s1", "target")] = activeMember("s1", "target", RoleMember)

	service := newService(t, repo)
	err := service.ChangeMemberRole(context.Background(),
		repo.members[memberKey("s1", "admin")], "s1", "target", RoleEditor, "req_1")
	require.NoError(t, err)

	require.Equal(t, RoleEditor, repo.members[memberKey("s1", "target")].Role)
	require.Len(t, repo.audits, 1)
	require.Equal(t, "site.member.role_changed", repo.audits[0].Action)
	require.Equal(t, "req_1", repo.audits[0].RequestID)
}

func TestChangeMemberRoleRejectsCrossSiteActor(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}, {ID: "s2"}}
	repo.members[memberKey("s2", "admin")] = activeMember("s2", "admin", RoleSiteAdmin)
	repo.members[memberKey("s1", "target")] = activeMember("s1", "target", RoleMember)

	err := newService(t, repo).ChangeMemberRole(context.Background(),
		repo.members[memberKey("s2", "admin")], "s1", "target", RoleEditor, "")
	require.ErrorIs(t, err, ErrCrossSite)
	require.Zero(t, repo.roleUpdates)
}

func TestChangeMemberRoleRejectsOrdinaryMember(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "user")] = activeMember("s1", "user", RoleMember)
	repo.members[memberKey("s1", "target")] = activeMember("s1", "target", RoleMember)

	err := newService(t, repo).ChangeMemberRole(context.Background(),
		repo.members[memberKey("s1", "user")], "s1", "target", RoleEditor, "")
	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Zero(t, repo.roleUpdates)
}

func TestChangeMemberRoleRejectsDemotingPlatformAdminBySiteAdmin(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	repo.members[memberKey("s1", "root")] = activeMember("s1", "root", RolePlatformAdmin)

	err := newService(t, repo).ChangeMemberRole(context.Background(),
		repo.members[memberKey("s1", "admin")], "s1", "root", RoleMember, "")
	require.ErrorIs(t, err, ErrPermissionDenied)
}

func TestChangeMemberRoleRejectsInvalidRole(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)

	err := newService(t, repo).ChangeMemberRole(context.Background(),
		repo.members[memberKey("s1", "admin")], "s1", "admin", Role("superuser"), "")
	require.ErrorIs(t, err, ErrInvalidRole)
}

func TestUpdateSettingsValidatesAndRecordsAudit(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	service := newService(t, repo)
	actor := repo.members[memberKey("s1", "admin")]

	err := service.UpdateSettings(context.Background(), actor, "s1", SettingsInput{
		VisibilityMode: VisibilityMembersOnly,
		PublishMode:    PublishModeReview,
	}, "req_2")
	require.NoError(t, err)
	require.NotNil(t, repo.settings)
	require.Equal(t, VisibilityMembersOnly, repo.settings.VisibilityMode)
	require.Len(t, repo.audits, 1)

	err = service.UpdateSettings(context.Background(), actor, "s1", SettingsInput{
		VisibilityMode: "everyone",
	}, "")
	require.ErrorIs(t, err, ErrInvalidInput)

	err = service.UpdateSettings(context.Background(), actor, "s1", SettingsInput{
		PublishMode: "anarchy",
	}, "")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestUpdateSettingsRejectsEditor(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "editor")] = activeMember("s1", "editor", RoleEditor)

	err := newService(t, repo).UpdateSettings(context.Background(),
		repo.members[memberKey("s1", "editor")], "s1", SettingsInput{Name: "x"}, "")
	require.ErrorIs(t, err, ErrPermissionDenied)
}

func TestListMembersRequiresManager(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "user")] = activeMember("s1", "user", RoleMember)
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)

	service := newService(t, repo)

	_, err := service.ListMembers(context.Background(), repo.members[memberKey("s1", "user")], "s1", 10)
	require.ErrorIs(t, err, ErrPermissionDenied)

	members, err := service.ListMembers(context.Background(), repo.members[memberKey("s1", "admin")], "s1", 10)
	require.NoError(t, err)
	require.Len(t, members, 2)
}

func TestMembershipRejectsSuspended(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	suspended := activeMember("s1", "u1", RoleEditor)
	suspended.Status = MemberStatusSuspended
	repo.members[memberKey("s1", "u1")] = suspended

	_, err := newService(t, repo).Membership(context.Background(), "s1", "u1")
	require.ErrorIs(t, err, ErrMemberNotFound)
}
