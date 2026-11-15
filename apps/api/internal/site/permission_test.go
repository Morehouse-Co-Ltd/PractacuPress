package site

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// ListPermissionGroups mirrors the store query.
func (f *fakeRepo) ListPermissionGroups(_ context.Context, siteID string) ([]PermissionGroup, error) {
	stored := f.permissionGroups[siteID]
	out := make([]PermissionGroup, 0, len(stored))
	for _, key := range BuiltinGroupKeys {
		if group, ok := stored[key]; ok {
			out = append(out, group)
		}
	}
	for key, group := range stored {
		if !IsBuiltinGroupKey(key) {
			out = append(out, group)
		}
	}
	return out, nil
}

// UpsertPermissionGroup mirrors the store's create-or-replace.
func (f *fakeRepo) UpsertPermissionGroup(
	_ context.Context,
	siteID string,
	in PermissionGroup,
	audit AuditEntry,
) (PermissionGroup, error) {
	if f.permissionGroups[siteID] == nil {
		f.permissionGroups[siteID] = make(map[string]PermissionGroup)
	}
	f.permissionGroups[siteID][in.Key] = in
	if audit.Action != "" {
		f.audits = append(f.audits, audit)
	}
	return in, nil
}

// SetMemberGroup writes the key and role together like the store transaction.
func (f *fakeRepo) SetMemberGroup(
	_ context.Context,
	siteID, userID, groupKey string,
	role Role,
	audit AuditEntry,
) error {
	key := memberKey(siteID, userID)
	member, ok := f.members[key]
	if !ok {
		return ErrTargetNotFound
	}
	member.Role = role
	member.GroupKey = groupKey
	if group, ok := f.permissionGroups[siteID][groupKey]; ok {
		member.Permissions = group.Capabilities
		member.AdminAccess = group.AdminAccess
	}
	f.members[key] = member
	f.audits = append(f.audits, audit)
	return nil
}

func TestBuiltinGroupsSeedAndKeepTheirRoleMapping(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo)
	require.NoError(t, err)
	admin := activeMember("s1", "admin", RoleSiteAdmin)

	groups, err := service.ListPermissionGroups(context.Background(), admin, "s1")
	require.NoError(t, err)
	require.Len(t, groups, 5)

	// Renaming is allowed; the role the group maps to is not.
	renamed, err := service.SavePermissionGroup(context.Background(), admin, "s1", GroupAdmin, PermissionGroupInput{
		Name:         "运营组",
		Capabilities: AllCapabilities,
		AdminAccess:  true,
	}, "")
	require.NoError(t, err)
	require.Equal(t, "运营组", renamed.Name)
	require.Equal(t, RoleSiteAdmin, renamed.BaseRole)
	require.True(t, renamed.Builtin)

	groups, err = service.ListPermissionGroups(context.Background(), admin, "s1")
	require.NoError(t, err)
	found := false
	for _, group := range groups {
		if group.Key == GroupAdmin {
			found = true
			require.Equal(t, "运营组", group.Name, "the renamed label must be the stored one")
			require.Equal(t, RoleSiteAdmin, group.BaseRole, "renaming must not move the server role")
		}
	}
	require.True(t, found)
}

func TestCustomGroupCanNarrowButNeverEscalate(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo)
	require.NoError(t, err)
	admin := activeMember("s1", "admin", RoleSiteAdmin)
	repo.members[memberKey("s1", "admin")] = admin
	repo.members[memberKey("s1", "writer")] = activeMember("s1", "writer", RoleEditor)

	// The manage_permission capability is outside a custom group's ceiling even
	// when the caller asks for it.
	group, err := service.SavePermissionGroup(context.Background(), admin, "s1", "reviewer", PermissionGroupInput{
		Name:         "审稿人",
		BaseRole:     RoleEditor,
		Capabilities: []Capability{CapabilityReadContent, CapabilityComment, CapabilityModerateComment, CapabilityManagePermission},
		AdminAccess:  true,
	}, "")
	require.NoError(t, err)
	require.Equal(t, RoleEditor, group.BaseRole)
	require.False(t, group.Builtin)
	require.False(t, group.Capabilities.Allows(CapabilityManagePermission),
		"a custom group must never be able to rewrite the matrix that restricts it")

	// Assigning the group updates the role and the matrix together.
	err = service.AssignMemberGroup(context.Background(), admin, "s1", "writer", "reviewer", "")
	require.NoError(t, err)

	member, err := service.Membership(context.Background(), "s1", "writer")
	require.NoError(t, err)
	require.Equal(t, "reviewer", member.GroupKey)
	require.Equal(t, RoleEditor, member.Role)
	require.True(t, member.Allows(CapabilityModerateComment))
	require.False(t, member.Allows(CapabilityWriteContent), "the narrowed matrix must revoke content creation")
	require.False(t, member.Allows(CapabilityManageSite))
}

func TestLegacyMatrixIsImportedWhenSeeding(t *testing.T) {
	repo := newFakeRepo()
	repo.customization["s1"] = Customization{
		Document: []byte(`{"permissions":{"member":{"admin_access":false,"capabilities":{"read_content":true,"comment":false,"write_content":true}}}}`),
	}
	service, err := NewService(repo)
	require.NoError(t, err)
	admin := activeMember("s1", "admin", RoleSiteAdmin)

	groups, err := service.ListPermissionGroups(context.Background(), admin, "s1")
	require.NoError(t, err)
	for _, group := range groups {
		if group.Key != GroupMember {
			continue
		}
		require.True(t, group.Capabilities.Allows(CapabilityReadContent))
		require.True(t, group.Capabilities.Allows(CapabilityWriteContent))
		require.False(t, group.Capabilities.Allows(CapabilityComment),
			"an existing installation's matrix must survive the move to the server")
		return
	}
	t.Fatal("member group was not seeded")
}

func TestGuestCannotBeAssigned(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo)
	require.NoError(t, err)
	admin := activeMember("s1", "admin", RoleSiteAdmin)
	repo.members[memberKey("s1", "admin")] = admin
	repo.members[memberKey("s1", "writer")] = activeMember("s1", "writer", RoleMember)

	require.ErrorIs(t, service.AssignMemberGroup(context.Background(), admin, "s1", "writer", GroupGuest, ""), ErrInvalidInput)
}

// TestHighestAdminGroupIsFixed keeps the owner group attached to the account that
// registered the site: no one can be promoted into it, and the owner cannot be
// moved out of it, even when a second platform administrator exists.
func TestHighestAdminGroupIsFixed(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo)
	require.NoError(t, err)
	root := activeMember("s1", "root", RolePlatformAdmin)
	other := activeMember("s1", "other", RolePlatformAdmin)
	writer := activeMember("s1", "writer", RoleMember)
	repo.members[memberKey("s1", "root")] = root
	repo.members[memberKey("s1", "other")] = other
	repo.members[memberKey("s1", "writer")] = writer

	require.ErrorIs(t,
		service.AssignMemberGroup(context.Background(), root, "s1", "writer", GroupOwner, ""),
		ErrPlatformAdminLocked, "a second super admin must not be minted")
	require.ErrorIs(t,
		service.AssignMemberGroup(context.Background(), root, "s1", "root", GroupAdmin, ""),
		ErrPlatformAdminLocked, "the registered super admin must not be demoted")
	require.ErrorIs(t,
		service.AssignMemberGroup(context.Background(), root, "s1", "other", GroupMember, ""),
		ErrPlatformAdminLocked, "no platform administrator group is mutable")
	require.Equal(t, RoleMember, repo.members[memberKey("s1", "writer")].Role)
	require.Equal(t, RolePlatformAdmin, repo.members[memberKey("s1", "root")].Role)
	require.Equal(t, RolePlatformAdmin, repo.members[memberKey("s1", "other")].Role)

	// Re-applying the owner group to the owner is a no-op, not a promotion.
	require.NoError(t, service.AssignMemberGroup(context.Background(), root, "s1", "root", GroupOwner, ""))
}

// TestSavePermissionGroupRequiresManagePermission keeps the write path behind the
// same capability the dashboard checks: an editor can read the matrix but cannot
// rewrite it.
func TestSavePermissionGroupRequiresManagePermission(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo)
	require.NoError(t, err)
	editor := activeMember("s1", "editor", RoleEditor)

	_, err = service.SavePermissionGroup(context.Background(), editor, "s1", "reviewer", PermissionGroupInput{
		Name:         "审稿人",
		BaseRole:     RoleEditor,
		Capabilities: []Capability{CapabilityReadContent},
	}, "")

	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Empty(t, repo.audits)
}

// TestPermissionGroupNameIsTruncatedByRunes guards the store's rune-count limit:
// slicing a 61-character Chinese label by bytes would leave an invalid UTF-8 tail.
func TestPermissionGroupNameIsTruncatedByRunes(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo)
	require.NoError(t, err)
	admin := activeMember("s1", "admin", RoleSiteAdmin)

	saved, err := service.SavePermissionGroup(context.Background(), admin, "s1", GroupAdmin, PermissionGroupInput{
		Name:         strings.Repeat("组", 61),
		Capabilities: AllCapabilities,
		AdminAccess:  true,
	}, "")
	require.NoError(t, err)
	require.Equal(t, strings.Repeat("组", 60), saved.Name)
}

// TestCustomGroupKeyFitsTheAuditTarget keeps the API ceiling aligned with
// audit_logs.target_id: the key is written as the audit target in the same
// transaction, so a longer key would make an otherwise valid save fail.
func TestCustomGroupKeyFitsTheAuditTarget(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo)
	require.NoError(t, err)
	admin := activeMember("s1", "admin", RoleSiteAdmin)

	valid := "g" + strings.Repeat("x", 35)
	_, err = service.SavePermissionGroup(context.Background(), admin, "s1", valid, PermissionGroupInput{
		Name:         "Long key",
		BaseRole:     RoleMember,
		Capabilities: []Capability{CapabilityReadContent},
	}, "")
	require.NoError(t, err)

	tooLong := valid + "x"
	_, err = service.SavePermissionGroup(context.Background(), admin, "s1", tooLong, PermissionGroupInput{
		Name:         "Too long",
		BaseRole:     RoleMember,
		Capabilities: []Capability{CapabilityReadContent},
	}, "")
	require.ErrorIs(t, err, ErrInvalidInput)
}

// TestSavePermissionGroupAuditsTheRename keeps the operator visible label in the
// audit detail; the target id alone would not tell an auditor what changed.
func TestSavePermissionGroupAuditsTheRename(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo)
	require.NoError(t, err)
	admin := activeMember("s1", "admin", RoleSiteAdmin)

	_, err = service.SavePermissionGroup(context.Background(), admin, "s1", GroupAdmin, PermissionGroupInput{
		Name:         "运营组",
		Capabilities: AllCapabilities,
		AdminAccess:  true,
	}, "req_7")
	require.NoError(t, err)

	require.Len(t, repo.audits, 1)
	audit := repo.audits[0]
	require.Equal(t, "site.permission_group.saved", audit.Action)
	require.Equal(t, "req_7", audit.RequestID)
	require.Equal(t, "运营组", audit.Detail["name"])
	require.Equal(t, string(RoleSiteAdmin), audit.Detail["base_role"])
	require.Equal(t, true, audit.Detail["builtin"])
}
