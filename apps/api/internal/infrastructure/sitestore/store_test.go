package sitestore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

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

func TestUpdateMemberRoleResetsGroupToBuiltin(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)
	userRow, err := handle.Client.User.Create().SetDisplayName("Alice").Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.SiteMember.Create().
		SetSiteID(siteRow.ID).SetUserID(userRow.ID).SetRole(string(site.RoleMember)).
		SetGroupKey("ops").
		Save(ctx)
	require.NoError(t, err)

	err = store.UpdateMemberRole(ctx, siteRow.ID, userRow.ID, site.RoleEditor, site.AuditEntry{
		Action: "site.member.role_changed",
	})
	require.NoError(t, err)

	member, err := store.FindMember(ctx, siteRow.ID, userRow.ID)
	require.NoError(t, err)
	require.Equal(t, site.RoleEditor, member.Role)
	require.Equal(t, site.GroupKeyForRole(site.RoleEditor), member.GroupKey,
		"a coarse role change must not leave a custom group with the old base role attached")
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

// TestToSiteReadsRegistrationAndChallengeFields pins the row to domain projection for
// the O-3 switch and the V-12 token.
func TestToSiteReadsRegistrationAndChallengeFields(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	created, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	found, err := store.FindByID(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, found.RegistrationOpen, "the schema default allows sign-ups")

	_, err = handle.Client.Site.UpdateOneID(created.ID).
		SetDomain("press.example.com").
		SetDomainVerificationToken("challenge-token").
		Save(ctx)
	require.NoError(t, err)

	found, err = store.FindByID(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, "press.example.com", found.Domain)
	require.Equal(t, "challenge-token", found.DomainVerificationToken)
	require.Nil(t, found.DomainVerifiedAt)
	require.True(t, found.RegistrationOpen)
}

func TestUpdateDomainPersistsChallengeThenVerificationThenClear(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	created, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	// Declaring a domain stores the challenge and leaves verification empty.
	err = store.UpdateDomain(ctx, created.ID, site.DomainInput{
		Domain: "press.example.com", Token: "challenge-token",
	}, site.AuditEntry{SiteID: created.ID, Action: "site.domain.updated"})
	require.NoError(t, err)

	row, err := handle.Client.Site.Get(ctx, created.ID)
	require.NoError(t, err)
	require.NotNil(t, row.Domain)
	require.Equal(t, "press.example.com", *row.Domain)
	require.NotNil(t, row.DomainVerificationToken)
	require.Equal(t, "challenge-token", *row.DomainVerificationToken)
	require.Nil(t, row.DomainVerifiedAt)

	// The successful challenge keeps the token and sets the timestamp.
	verifiedAt := time.Now().UTC().Truncate(time.Second)
	err = store.UpdateDomain(ctx, created.ID, site.DomainInput{
		Domain: "press.example.com", Token: "challenge-token", VerifiedAt: &verifiedAt,
	}, site.AuditEntry{SiteID: created.ID, Action: "site.domain.verified"})
	require.NoError(t, err)

	row, err = handle.Client.Site.Get(ctx, created.ID)
	require.NoError(t, err)
	require.NotNil(t, row.DomainVerifiedAt)
	require.True(t, row.DomainVerifiedAt.Equal(verifiedAt))

	// Clearing drops all three columns.
	err = store.UpdateDomain(ctx, created.ID, site.DomainInput{},
		site.AuditEntry{SiteID: created.ID, Action: "site.domain.updated"})
	require.NoError(t, err)

	row, err = handle.Client.Site.Get(ctx, created.ID)
	require.NoError(t, err)
	require.Nil(t, row.Domain)
	require.Nil(t, row.DomainVerificationToken)
	require.Nil(t, row.DomainVerifiedAt)

	entries, err := handle.Client.AuditLog.Query().
		Where(auditlog.SiteIDEQ(created.ID)).
		All(ctx)
	require.NoError(t, err)
	require.Len(t, entries, 3)
}

func TestUpdateSettingsDomainStartsUnverifiedChallenge(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	verifiedAt := time.Now().UTC()
	created, err := handle.Client.Site.Create().
		SetSlug("main").SetName("Main").
		SetDomain("old.example.com").
		SetDomainVerifiedAt(verifiedAt).
		Save(ctx)
	require.NoError(t, err)

	closed := false
	err = store.UpdateSettings(ctx, created.ID, site.SettingsInput{
		Domain:           "new.example.com",
		DomainToken:      "new-token",
		RegistrationOpen: &closed,
	}, site.AuditEntry{SiteID: created.ID, Action: "site.settings.updated"})
	require.NoError(t, err)

	row, err := handle.Client.Site.Get(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, "new.example.com", *row.Domain)
	require.Equal(t, "new-token", *row.DomainVerificationToken)
	require.Nil(t, row.DomainVerifiedAt, "a domain written through settings is never auto-verified")
	require.False(t, row.RegistrationOpen)

	// A partial update without domain fields leaves the challenge untouched.
	reopen := true
	err = store.UpdateSettings(ctx, created.ID, site.SettingsInput{
		PublishMode:      site.PublishModeOpen,
		RegistrationOpen: &reopen,
	}, site.AuditEntry{SiteID: created.ID, Action: "site.settings.updated"})
	require.NoError(t, err)

	row, err = handle.Client.Site.Get(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, "new.example.com", *row.Domain)
	require.Equal(t, "new-token", *row.DomainVerificationToken)
	require.Nil(t, row.DomainVerifiedAt)
	require.True(t, row.RegistrationOpen)
}
