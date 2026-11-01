package site

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeRepo is an in memory site.Repository for the service tests.
type fakeRepo struct {
	sites          []Site
	members        map[string]Member
	roleUpdates    int
	profileUpdates int
	statusUpdates  int
	deletes        int
	domainUpdates  int
	audits         []AuditEntry
	settings       *SettingsInput
	// customization is the saved design document, keyed by site id. A missing key means
	// the site never saved one.
	customization map[string]Customization
	saveConflicts int
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		members:       make(map[string]Member),
		customization: make(map[string]Customization),
	}
}

// Customization mirrors the store: a site without a saved design answers NotFound.
func (f *fakeRepo) Customization(_ context.Context, siteID string) (Customization, error) {
	saved, ok := f.customization[siteID]
	if !ok {
		return Customization{}, ErrCustomizationNotFound
	}
	return saved, nil
}

// SaveCustomization mirrors the store's conditional write, including the conflict when
// the stored revision has moved on.
func (f *fakeRepo) SaveCustomization(
	_ context.Context,
	siteID string,
	in CustomizationInput,
	audit AuditEntry,
) (Customization, error) {
	saved, exists := f.customization[siteID]
	if in.ExpectedRevision > 0 {
		if !exists || saved.Revision != in.ExpectedRevision {
			f.saveConflicts++
			return Customization{}, ErrCustomizationConflict
		}
	}
	revision := saved.Revision
	if !exists {
		revision = 0
	}
	saved = Customization{
		Document:  append([]byte(nil), in.Document...),
		Revision:  revision + 1,
		UpdatedAt: audit.At,
	}
	f.customization[siteID] = saved
	f.audits = append(f.audits, audit)
	return saved, nil
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

// CountAdmins mirrors the store query: active members who may administer the site.
func (f *fakeRepo) CountAdmins(_ context.Context, siteID string) (int, error) {
	count := 0
	for _, member := range f.members {
		if member.SiteID == siteID && member.IsActive() && member.Role.AtLeast(RoleSiteAdmin) {
			count++
		}
	}
	return count, nil
}

func (f *fakeRepo) UpdateMemberRole(_ context.Context, siteID, userID string, role Role, audit AuditEntry) error {
	key := memberKey(siteID, userID)
	member, ok := f.members[key]
	if !ok {
		return ErrTargetNotFound
	}
	member.Role = role
	f.members[key] = member
	f.roleUpdates++
	f.audits = append(f.audits, audit)
	return nil
}

// CountMembersByRole mirrors the store query: only active memberships count.
func (f *fakeRepo) CountMembersByRole(_ context.Context, siteID string, role Role) (int, error) {
	count := 0
	for _, member := range f.members {
		if member.SiteID == siteID && member.IsActive() && member.Role == role {
			count++
		}
	}
	return count, nil
}

func (f *fakeRepo) UpdateMemberProfile(_ context.Context, siteID, userID string, in MemberProfile, audit AuditEntry) error {
	key := memberKey(siteID, userID)
	member, ok := f.members[key]
	if !ok {
		return ErrTargetNotFound
	}
	if in.Email != nil {
		for otherKey, other := range f.members {
			if otherKey != key && other.Email == *in.Email {
				return ErrEmailTaken
			}
		}
		member.Email = *in.Email
	}
	if in.DisplayName != nil {
		member.DisplayName = *in.DisplayName
	}
	f.members[key] = member
	f.profileUpdates++
	f.audits = append(f.audits, audit)
	return nil
}

func (f *fakeRepo) UpdateMemberStatus(_ context.Context, siteID, userID, status string, audit AuditEntry) error {
	key := memberKey(siteID, userID)
	member, ok := f.members[key]
	if !ok {
		return ErrTargetNotFound
	}
	member.Status = status
	f.members[key] = member
	f.statusUpdates++
	f.audits = append(f.audits, audit)
	return nil
}

func (f *fakeRepo) DeleteMember(_ context.Context, siteID, userID string, audit AuditEntry) error {
	key := memberKey(siteID, userID)
	if _, ok := f.members[key]; !ok {
		return ErrTargetNotFound
	}
	delete(f.members, key)
	f.deletes++
	f.audits = append(f.audits, audit)
	return nil
}

func (f *fakeRepo) UpdateSettings(_ context.Context, _ string, in SettingsInput, audit AuditEntry) error {
	f.settings = &in
	f.audits = append(f.audits, audit)
	return nil
}

func (f *fakeRepo) UpdateDomain(_ context.Context, siteID string, in DomainInput, audit AuditEntry) error {
	for i := range f.sites {
		if f.sites[i].ID != siteID {
			continue
		}
		f.sites[i].Domain = in.Domain
		f.sites[i].DomainVerifiedAt = in.VerifiedAt
		f.domainUpdates++
		f.audits = append(f.audits, audit)
		return nil
	}
	return ErrNotFound
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

func newServiceWithOptions(t *testing.T, repo Repository, opts ...Option) *Service {
	t.Helper()
	service, err := NewService(repo, opts...)
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

// memberWithEmail builds a membership whose account has an email login identity.
func memberWithEmail(siteID, userID string, role Role, email string) Member {
	member := activeMember(siteID, userID, role)
	member.DisplayName = userID
	member.Email = email
	return member
}

func TestChangeMemberRoleRejectsDemotingLastPlatformAdmin(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "root")] = activeMember("s1", "root", RolePlatformAdmin)

	err := newService(t, repo).ChangeMemberRole(context.Background(),
		repo.members[memberKey("s1", "root")], "s1", "root", RoleMember, "")

	require.ErrorIs(t, err, ErrLastPlatformAdmin)
	require.Zero(t, repo.roleUpdates)
	require.Equal(t, RolePlatformAdmin, repo.members[memberKey("s1", "root")].Role)
}

func TestChangeMemberRoleAllowsDemotingOneOfTwoPlatformAdmins(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "root1")] = activeMember("s1", "root1", RolePlatformAdmin)
	repo.members[memberKey("s1", "root2")] = activeMember("s1", "root2", RolePlatformAdmin)

	err := newService(t, repo).ChangeMemberRole(context.Background(),
		repo.members[memberKey("s1", "root1")], "s1", "root2", RoleSiteAdmin, "")

	require.NoError(t, err)
	require.Equal(t, RoleSiteAdmin, repo.members[memberKey("s1", "root2")].Role)
}

func TestChangeMemberRoleUnknownTargetIsNotFound(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)

	err := newService(t, repo).ChangeMemberRole(context.Background(),
		repo.members[memberKey("s1", "admin")], "s1", "ghost", RoleEditor, "")

	require.ErrorIs(t, err, ErrTargetNotFound)
}

// setupProfileFixture returns a site with a platform administrator actor and an
// ordinary member target.
func setupProfileFixture() (*fakeRepo, Member, Member) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	actor := memberWithEmail("s1", "root", RolePlatformAdmin, "root@example.com")
	target := memberWithEmail("s1", "target", RoleMember, "old@example.com")
	repo.members[memberKey("s1", "root")] = actor
	repo.members[memberKey("s1", "target")] = target
	return repo, actor, target
}

func TestUpdateMemberProfileChangesNameAndEmail(t *testing.T) {
	repo, actor, _ := setupProfileFixture()
	service := newService(t, repo)

	name := "New Name"
	email := "NEW@example.com"
	updated, err := service.UpdateMemberProfile(context.Background(), actor, "s1", "target",
		MemberProfile{DisplayName: &name, Email: &email}, "req_1")
	require.NoError(t, err)

	require.Equal(t, "New Name", updated.DisplayName)
	require.Equal(t, "new@example.com", updated.Email)
	require.Equal(t, "New Name", repo.members[memberKey("s1", "target")].DisplayName)
	require.Equal(t, "new@example.com", repo.members[memberKey("s1", "target")].Email)
	require.Len(t, repo.audits, 1)
	require.Equal(t, "site.member.profile_updated", repo.audits[0].Action)
}

func TestUpdateMemberProfileRejectsSiteAdmin(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	repo.members[memberKey("s1", "target")] = memberWithEmail("s1", "target", RoleMember, "old@example.com")

	name := "New Name"
	_, err := newService(t, repo).UpdateMemberProfile(context.Background(),
		repo.members[memberKey("s1", "admin")], "s1", "target",
		MemberProfile{DisplayName: &name}, "")

	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Zero(t, repo.profileUpdates)
}

func TestUpdateMemberProfileRejectsSelf(t *testing.T) {
	repo, actor, _ := setupProfileFixture()

	name := "Renamed"
	_, err := newService(t, repo).UpdateMemberProfile(context.Background(), actor, "s1", "root",
		MemberProfile{DisplayName: &name}, "")

	require.ErrorIs(t, err, ErrCannotManageSelf)
	require.Zero(t, repo.profileUpdates)
}

func TestUpdateMemberProfileRejectsAnotherPlatformAdmin(t *testing.T) {
	repo, actor, _ := setupProfileFixture()
	repo.members[memberKey("s1", "other")] = activeMember("s1", "other", RolePlatformAdmin)

	name := "Renamed"
	_, err := newService(t, repo).UpdateMemberProfile(context.Background(), actor, "s1", "other",
		MemberProfile{DisplayName: &name}, "")

	require.ErrorIs(t, err, ErrTargetTooPrivileged)
	require.Zero(t, repo.profileUpdates)
}

func TestUpdateMemberProfileUnknownTargetIsNotFound(t *testing.T) {
	repo, actor, _ := setupProfileFixture()

	name := "Renamed"
	_, err := newService(t, repo).UpdateMemberProfile(context.Background(), actor, "s1", "ghost",
		MemberProfile{DisplayName: &name}, "")

	require.ErrorIs(t, err, ErrTargetNotFound)
}

func TestUpdateMemberProfileRejectsEmailTakenByAnotherAccount(t *testing.T) {
	repo, actor, _ := setupProfileFixture()

	email := "root@example.com"
	_, err := newService(t, repo).UpdateMemberProfile(context.Background(), actor, "s1", "target",
		MemberProfile{Email: &email}, "")

	require.ErrorIs(t, err, ErrEmailTaken)
	require.Zero(t, repo.profileUpdates)
	require.Equal(t, "old@example.com", repo.members[memberKey("s1", "target")].Email)
}

func TestUpdateMemberProfileRejectsEmptyAndMalformedPatches(t *testing.T) {
	repo, actor, _ := setupProfileFixture()
	service := newService(t, repo)

	_, err := service.UpdateMemberProfile(context.Background(), actor, "s1", "target", MemberProfile{}, "")
	require.ErrorIs(t, err, ErrInvalidInput)

	badEmail := "not-an-email"
	_, err = service.UpdateMemberProfile(context.Background(), actor, "s1", "target",
		MemberProfile{Email: &badEmail}, "")
	require.ErrorIs(t, err, ErrInvalidInput)

	blankName := "   "
	_, err = service.UpdateMemberProfile(context.Background(), actor, "s1", "target",
		MemberProfile{DisplayName: &blankName}, "")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestUpdateMemberProfileAcceptingUnchangedEmailIsNotAConflict(t *testing.T) {
	repo, actor, _ := setupProfileFixture()

	email := "old@example.com"
	name := "Target Renamed"
	updated, err := newService(t, repo).UpdateMemberProfile(context.Background(), actor, "s1", "target",
		MemberProfile{DisplayName: &name, Email: &email}, "")

	require.NoError(t, err)
	require.Equal(t, "Target Renamed", updated.DisplayName)
	require.Equal(t, "old@example.com", repo.members[memberKey("s1", "target")].Email)
}

func TestUpdateMemberStatusSuspendsAndReactivates(t *testing.T) {
	repo, actor, _ := setupProfileFixture()
	service := newService(t, repo)

	suspended, err := service.UpdateMemberStatus(context.Background(), actor, "s1", "target", MemberStatusSuspended, "")
	require.NoError(t, err)
	require.Equal(t, MemberStatusSuspended, suspended.Status)
	require.Equal(t, MemberStatusSuspended, repo.members[memberKey("s1", "target")].Status)

	active, err := service.UpdateMemberStatus(context.Background(), actor, "s1", "target", MemberStatusActive, "")
	require.NoError(t, err)
	require.Equal(t, MemberStatusActive, active.Status)
	require.Len(t, repo.audits, 2)
}

func TestUpdateMemberStatusRejectsInvalidStatus(t *testing.T) {
	repo, actor, _ := setupProfileFixture()

	_, err := newService(t, repo).UpdateMemberStatus(context.Background(), actor, "s1", "target", MemberStatusInvited, "")
	require.ErrorIs(t, err, ErrInvalidInput)
	require.Zero(t, repo.statusUpdates)

	_, err = newService(t, repo).UpdateMemberStatus(context.Background(), actor, "s1", "target", "disabled", "")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestUpdateMemberStatusRejectsSiteAdminAndSelf(t *testing.T) {
	repo, actor, _ := setupProfileFixture()
	service := newService(t, repo)

	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	_, err := service.UpdateMemberStatus(context.Background(),
		repo.members[memberKey("s1", "admin")], "s1", "target", MemberStatusSuspended, "")
	require.ErrorIs(t, err, ErrPermissionDenied)

	_, err = service.UpdateMemberStatus(context.Background(), actor, "s1", "root", MemberStatusSuspended, "")
	require.ErrorIs(t, err, ErrCannotManageSelf)

	repo.members[memberKey("s1", "other")] = activeMember("s1", "other", RolePlatformAdmin)
	_, err = service.UpdateMemberStatus(context.Background(), actor, "s1", "other", MemberStatusSuspended, "")
	require.ErrorIs(t, err, ErrTargetTooPrivileged)
	require.Zero(t, repo.statusUpdates)
}

func TestDeleteMemberRemovesMembershipOnly(t *testing.T) {
	repo, actor, _ := setupProfileFixture()
	service := newService(t, repo)

	err := service.DeleteMember(context.Background(), actor, "s1", "target", "req_1")
	require.NoError(t, err)

	_, exists := repo.members[memberKey("s1", "target")]
	require.False(t, exists)
	require.Equal(t, 1, repo.deletes)
	require.Len(t, repo.audits, 1)
	require.Equal(t, "site.member.removed", repo.audits[0].Action)
}

func TestDeleteMemberRejectsUnauthorizedCases(t *testing.T) {
	repo, actor, _ := setupProfileFixture()
	service := newService(t, repo)

	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	err := service.DeleteMember(context.Background(), repo.members[memberKey("s1", "admin")], "s1", "target", "")
	require.ErrorIs(t, err, ErrPermissionDenied)

	err = service.DeleteMember(context.Background(), actor, "s1", "root", "")
	require.ErrorIs(t, err, ErrCannotManageSelf)

	err = service.DeleteMember(context.Background(), actor, "s1", "ghost", "")
	require.ErrorIs(t, err, ErrTargetNotFound)

	require.Zero(t, repo.deletes)
}

func TestPublicMemberReturnsActiveMember(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "alice")] = memberWithEmail("s1", "alice", RoleEditor, "alice@example.com")

	member, err := newService(t, repo).PublicMember(context.Background(), "s1", "alice")

	require.NoError(t, err)
	require.Equal(t, "alice", member.UserID)
	require.Equal(t, "alice", member.DisplayName)
	require.Equal(t, RoleEditor, member.Role)
}

func TestPublicMemberHidesUnknownSuspendedAndOtherSiteMembers(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}, {ID: "s2"}}
	suspended := activeMember("s1", "suspended", RoleMember)
	suspended.Status = MemberStatusSuspended
	repo.members[memberKey("s1", "suspended")] = suspended
	repo.members[memberKey("s2", "bob")] = activeMember("s2", "bob", RoleMember)

	service := newService(t, repo)
	ctx := context.Background()

	_, err := service.PublicMember(ctx, "s1", "ghost")
	require.ErrorIs(t, err, ErrTargetNotFound, "an unknown account is not found")

	_, err = service.PublicMember(ctx, "s1", "suspended")
	require.ErrorIs(t, err, ErrTargetNotFound, "a suspended membership is not a public author")

	_, err = service.PublicMember(ctx, "s1", "bob")
	require.ErrorIs(t, err, ErrTargetNotFound, "members of another site are invisible")
}

// --- primary domain and the public address fallback ------------------------

func TestUpdateDomainStoresVerificationAndResolves(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	service := newService(t, repo)

	err := service.UpdateDomain(context.Background(),
		repo.members[memberKey("s1", "admin")], "s1", "Press.Example.com.", "req_1")
	require.NoError(t, err)

	require.Equal(t, "press.example.com", repo.sites[0].Domain)
	require.NotNil(t, repo.sites[0].DomainVerifiedAt, "an operator supplied domain is stored as verified")
	require.Equal(t, 1, repo.domainUpdates)
	require.Len(t, repo.audits, 1)
	require.Equal(t, "site.domain.updated", repo.audits[0].Action)

	found, err := service.Resolve(context.Background(), "press.example.com")
	require.NoError(t, err)
	require.Equal(t, "s1", found.ID)
}

func TestUpdateDomainClearsDomainAndVerification(t *testing.T) {
	verified := time.Now().UTC()
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1", Domain: "press.example.com", DomainVerifiedAt: &verified}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	service := newService(t, repo)
	actor := repo.members[memberKey("s1", "admin")]

	require.NoError(t, service.UpdateDomain(context.Background(), actor, "s1", "", ""))
	require.Empty(t, repo.sites[0].Domain)
	require.Nil(t, repo.sites[0].DomainVerifiedAt)

	// With the domain cleared the single site fallback answers again.
	found, err := service.Resolve(context.Background(), "127.0.0.1")
	require.NoError(t, err)
	require.Equal(t, "s1", found.ID)
}

func TestUpdateDomainAcceptsPunycodeAndTrailingDot(t *testing.T) {
	cases := map[string]string{
		"xn--bcher-kva.example": "xn--bcher-kva.example",
		"Press.Example.COM.":    "press.example.com",
	}
	for input, want := range cases {
		repo := newFakeRepo()
		repo.sites = []Site{{ID: "s1"}}
		repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
		service := newService(t, repo)
		actor := repo.members[memberKey("s1", "admin")]

		require.NoError(t, service.UpdateDomain(context.Background(), actor, "s1", input, ""), input)
		require.Equal(t, want, repo.sites[0].Domain, input)
	}
}

func TestUpdateDomainRejectsInvalidHostnames(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	service := newService(t, repo)
	actor := repo.members[memberKey("s1", "admin")]

	invalid := []string{
		"https://example.com",
		"example.com/path",
		"example.com:8080",
		"*.example.com",
		"127.0.0.1",
		"bad_domain.example",
		"exa mple.com",
		" example.com",
		"example..com",
		"-bad.example.com",
		"example.com-",
		".",
		strings.Repeat("a", MaxDomainLength+1),
	}
	for _, domain := range invalid {
		err := service.UpdateDomain(context.Background(), actor, "s1", domain, "")
		require.ErrorIs(t, err, ErrInvalidInput, "domain %q must be rejected", domain)
	}
	require.Zero(t, repo.domainUpdates)
}

func TestUpdateDomainRejectsDomainOwnedByAnotherSite(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}, {ID: "s2", Domain: "taken.example.com"}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	service := newService(t, repo)

	err := service.UpdateDomain(context.Background(),
		repo.members[memberKey("s1", "admin")], "s1", "TAKEN.example.com", "")

	require.ErrorIs(t, err, ErrDomainTaken)
	require.Empty(t, repo.sites[0].Domain)
	require.Zero(t, repo.domainUpdates)
}

func TestUpdateDomainRequiresSiteAdministratorOfTheSite(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}, {ID: "s2"}}
	repo.members[memberKey("s1", "editor")] = activeMember("s1", "editor", RoleEditor)
	repo.members[memberKey("s2", "root")] = activeMember("s2", "root", RoleSiteAdmin)
	service := newService(t, repo)

	err := service.UpdateDomain(context.Background(),
		repo.members[memberKey("s1", "editor")], "s1", "press.example.com", "")
	require.ErrorIs(t, err, ErrPermissionDenied)

	err = service.UpdateDomain(context.Background(),
		repo.members[memberKey("s2", "root")], "s1", "press.example.com", "")
	require.ErrorIs(t, err, ErrCrossSite)

	require.Zero(t, repo.domainUpdates)
}

func TestUpdateSettingsVerifiesANewDomain(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "s1"}}
	repo.members[memberKey("s1", "admin")] = activeMember("s1", "admin", RoleSiteAdmin)
	service := newService(t, repo)
	actor := repo.members[memberKey("s1", "admin")]

	require.NoError(t, service.UpdateSettings(context.Background(), actor, "s1", SettingsInput{
		Name:   "Main",
		Domain: "Press.example.com.",
	}, ""))
	require.NotNil(t, repo.settings)
	require.Equal(t, "press.example.com", repo.settings.Domain)
	require.NotNil(t, repo.settings.DomainVerifiedAt, "settings must not store an unverified domain")

	err := service.UpdateSettings(context.Background(), actor, "s1", SettingsInput{Domain: "https://bad"}, "")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestResolveWithoutDomainRequiresPublicAddressWhenEnabled(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "only"}}
	service := newServiceWithOptions(t, repo, RequirePublicAddress(true))
	ctx := context.Background()

	for _, host := range []string{"203.0.113.10", "2001:db8::1"} {
		found, err := service.Resolve(ctx, host)
		require.NoError(t, err, "host %q is a public literal", host)
		require.Equal(t, "only", found.ID)
	}

	for _, host := range []string{
		"localhost", "127.0.0.1", "::1", "0.0.0.0",
		"10.1.2.3", "192.168.1.7", "172.16.0.5", "169.254.1.1",
		"example.com", "press.example.com",
	} {
		_, err := service.Resolve(ctx, host)
		require.ErrorIs(t, err, ErrNotFound, "host %q must not reach a domain-less site in production", host)
	}
}

func TestResolveWithoutDomainIsPermissiveWhenOptionDisabled(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "only"}}
	service := newService(t, repo)
	ctx := context.Background()

	for _, host := range []string{"127.0.0.1", "localhost", "10.1.2.3", "example.com"} {
		found, err := service.Resolve(ctx, host)
		require.NoError(t, err, host)
		require.Equal(t, "only", found.ID)
	}
}

func TestResolveWithVerifiedDomainIgnoresPublicAddressOption(t *testing.T) {
	verified := time.Now().UTC()
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "only", Domain: "press.example.com", DomainVerifiedAt: &verified}}
	service := newServiceWithOptions(t, repo, RequirePublicAddress(true))
	ctx := context.Background()

	found, err := service.Resolve(ctx, "press.example.com")
	require.NoError(t, err)
	require.Equal(t, "only", found.ID)

	// A site that has a domain is reachable only through that domain; the fallback is
	// inactive whether or not the option is on.
	_, err = service.Resolve(ctx, "203.0.113.10")
	require.ErrorIs(t, err, ErrNotFound)
	_, err = service.Resolve(ctx, "127.0.0.1")
	require.ErrorIs(t, err, ErrNotFound)
}
