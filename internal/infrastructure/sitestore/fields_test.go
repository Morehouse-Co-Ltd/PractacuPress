package sitestore_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/internal/platform/fieldcrypto"
	"github.com/practacu/practacu-press/internal/platform/identitycrypto"
	"github.com/practacu/practacu-press/internal/site"

	"github.com/practacu/practacu-press/internal/ent/useridentity"
)

func sealedStoreSetup(t *testing.T) (*sitestore.Store, *db.DB, *fieldcrypto.Cipher) {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "site-sealed.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i*5 + 1)
	}
	cipher, err := fieldcrypto.New(key)
	require.NoError(t, err)
	codec := identitycrypto.New(cipher)

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	subject, err := codec.SealSubject("email", "Alice@Example.com")
	require.NoError(t, err)
	email, err := codec.SealEmail("Alice@Example.com")
	require.NoError(t, err)

	userRow, err := handle.Client.User.Create().SetDisplayName("Alice").Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.UserIdentity.Create().
		SetUserID(userRow.ID).
		SetProvider("email").
		SetProviderSubject(subject).
		SetEmail(email).
		Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.SiteMember.Create().
		SetSiteID(siteRow.ID).
		SetUserID(userRow.ID).
		SetRole(string(site.RoleMember)).
		Save(ctx)
	require.NoError(t, err)

	// The columns really are ciphertext on disk.
	stored, err := handle.Client.UserIdentity.Query().
		Where(useridentity.UserIDEQ(userRow.ID)).
		Only(ctx)
	require.NoError(t, err)
	require.True(t, identitycrypto.IsSealed(stored.ProviderSubject))
	require.NotNil(t, stored.Email)
	require.True(t, identitycrypto.IsSealed(*stored.Email))

	return sitestore.New(handle.Client, sitestore.WithFieldCipher(cipher)), handle, cipher
}

func TestListMembersDecryptsSealedEmails(t *testing.T) {
	store, handle, _ := sealedStoreSetup(t)
	ctx := context.Background()

	members, err := store.ListMembers(ctx, mustSingleSiteID(t, handle, ctx), 10)
	require.NoError(t, err)
	require.Len(t, members, 1)
	require.Equal(t, "alice@example.com", members[0].Email,
		"the admin member list must show the address, not its envelope")
}

func TestFindMemberDecryptsSealedEmail(t *testing.T) {
	store, handle, _ := sealedStoreSetup(t)
	ctx := context.Background()

	member, err := store.ListMembers(ctx, mustSingleSiteID(t, handle, ctx), 10)
	require.NoError(t, err)
	require.Len(t, member, 1)

	found, err := store.FindMember(ctx, mustSingleSiteID(t, handle, ctx), member[0].UserID)
	require.NoError(t, err)
	require.Equal(t, "alice@example.com", found.Email)
}

func TestListMembersReadsLegacyPlaintextEmail(t *testing.T) {
	ctx := context.Background()
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "site-legacy.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)
	userRow, err := handle.Client.User.Create().SetDisplayName("Legacy").Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.UserIdentity.Create().
		SetUserID(userRow.ID).
		SetProvider("email").
		SetProviderSubject("legacy@example.com").
		SetEmail("legacy@example.com").
		Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.SiteMember.Create().
		SetSiteID(siteRow.ID).
		SetUserID(userRow.ID).
		SetRole(string(site.RoleMember)).
		Save(ctx)
	require.NoError(t, err)

	key := make([]byte, 32)
	cipher, err := fieldcrypto.New(key)
	require.NoError(t, err)
	store := sitestore.New(handle.Client, sitestore.WithFieldCipher(cipher))

	members, err := store.ListMembers(ctx, siteRow.ID, 10)
	require.NoError(t, err)
	require.Len(t, members, 1)
	require.Equal(t, "legacy@example.com", members[0].Email)
}

func TestListMembersFailsLoudlyWithWrongKey(t *testing.T) {
	_, handle, _ := sealedStoreSetup(t)
	ctx := context.Background()

	otherKey := make([]byte, 32)
	otherKey[0] = 0x42
	other, err := fieldcrypto.New(otherKey)
	require.NoError(t, err)
	store := sitestore.New(handle.Client, sitestore.WithFieldCipher(other))

	_, err = store.ListMembers(ctx, mustSingleSiteID(t, handle, ctx), 10)
	require.Error(t, err, "a wrong key must not fall back to showing the envelope")
}

func mustSingleSiteID(t *testing.T, handle *db.DB, ctx context.Context) string {
	t.Helper()
	row, err := handle.Client.Site.Query().Only(ctx)
	require.NoError(t, err)
	return row.ID
}
