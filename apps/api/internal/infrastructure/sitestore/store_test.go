package sitestore_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	"github.com/practacu/practacu-press/apps/api/ent/auditlog"
)

func newStore(t *testing.T) (*sitestore.Store, *db.DB) {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "site.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	return sitestore.New(handle.Client), handle
}

func TestFindByDomain(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	created, err := handle.Client.Site.Create().
		SetSlug("main").SetName("Main").SetDomain("example.com").
		Save(ctx)
	require.NoError(t, err)

	found, err := store.FindByDomain(ctx, "example.com")
	require.NoError(t, err)
	require.Equal(t, created.ID, found.ID)
	require.Equal(t, "example.com", found.Domain)

	_, err = store.FindByDomain(ctx, "unknown.test")
	require.ErrorIs(t, err, site.ErrNotFound)
}

func TestSingleSite(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	_, ok, err := store.SingleSite(ctx)
	require.NoError(t, err)
	require.False(t, ok)

	only, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	found, ok, err := store.SingleSite(ctx)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, only.ID, found.ID)

	_, err = handle.Client.Site.Create().SetSlug("second").SetName("Second").Save(ctx)
	require.NoError(t, err)

	_, ok, err = store.SingleSite(ctx)
	require.NoError(t, err)
	require.False(t, ok, "a multi site deployment has no single site")
}

func TestUpdateMemberRoleWritesAudit(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)
	userRow, err := handle.Client.User.Create().SetDisplayName("Alice").Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.SiteMember.Create().
		SetSiteID(siteRow.ID).SetUserID(userRow.ID).SetRole(string(site.RoleMember)).
		Save(ctx)
	require.NoError(t, err)

	err = store.UpdateMemberRole(ctx, siteRow.ID, userRow.ID, site.RoleEditor, site.AuditEntry{
		SiteID:    siteRow.ID,
		ActorID:   "admin_1",
		Action:    "site.member.role_changed",
		RequestID: "req_9",
		Detail:    map[string]any{"to": "editor"},
	})
	require.NoError(t, err)

	member, err := store.FindMember(ctx, siteRow.ID, userRow.ID)
	require.NoError(t, err)
	require.Equal(t, site.RoleEditor, member.Role)
	require.Equal(t, "Alice", member.DisplayName)

	entries, err := handle.Client.AuditLog.Query().
		Where(auditlog.ActionEQ("site.member.role_changed")).
		All(ctx)
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "req_9", *entries[0].RequestID)
	require.Equal(t, "admin_1", *entries[0].ActorID)
}

func TestUpdateMemberRoleMissingMember(t *testing.T) {
	store, _ := newStore(t)

	err := store.UpdateMemberRole(context.Background(), "no-site", "no-user", site.RoleEditor, site.AuditEntry{
		Action: "site.member.role_changed",
	})
	require.ErrorIs(t, err, site.ErrMemberNotFound)
}

func TestListMembersReturnsDisplayNames(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	for _, name := range []string{"Alice", "Bob"} {
		userRow, err := handle.Client.User.Create().SetDisplayName(name).Save(ctx)
		require.NoError(t, err)
		_, err = handle.Client.SiteMember.Create().
			SetSiteID(siteRow.ID).SetUserID(userRow.ID).SetRole(string(site.RoleMember)).
			Save(ctx)
		require.NoError(t, err)
	}

	members, err := store.ListMembers(ctx, siteRow.ID, 10)
	require.NoError(t, err)
	require.Len(t, members, 2)

	names := []string{members[0].DisplayName, members[1].DisplayName}
	require.ElementsMatch(t, []string{"Alice", "Bob"}, names)
}

func TestUpdateSettingsIsPartial(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().
		SetSlug("main").SetName("Original").Save(ctx)
	require.NoError(t, err)

	err = store.UpdateSettings(ctx, siteRow.ID, site.SettingsInput{
		PublishMode: site.PublishModeOpen,
	}, site.AuditEntry{SiteID: siteRow.ID, Action: "site.settings.updated"})
	require.NoError(t, err)

	updated, err := handle.Client.Site.Get(ctx, siteRow.ID)
	require.NoError(t, err)
	require.Equal(t, "Original", updated.Name, "an omitted field must not be cleared")
	require.Equal(t, string(site.PublishModeOpen), updated.PublishMode)
}
