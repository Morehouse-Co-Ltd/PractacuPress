package platformstore_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/infrastructure/platformstore"
	"github.com/practacu/practacu-press/internal/platform/fieldcrypto"
	"github.com/practacu/practacu-press/internal/platform/identitycrypto"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/platformadmin"
)

// TestAccountDirectoryShowsDecryptedEmail pins the administrator-visible behaviour:
// the address is sealed in the database and readable in the console.
func TestAccountDirectoryShowsDecryptedEmail(t *testing.T) {
	ctx := context.Background()
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "platform-sealed.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i*3 + 9)
	}
	cipher, err := fieldcrypto.New(key)
	require.NoError(t, err)
	codec := identitycrypto.New(cipher)

	subject, err := codec.SealSubject("email", "Alice@Example.com")
	require.NoError(t, err)
	email, err := codec.SealEmail("Alice@Example.com")
	require.NoError(t, err)

	siteRow, err := handle.Client.Site.Create().SetSlug("console").SetName("Console").Save(ctx)
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
		SetRole("member").
		SetStatus("active").
		Save(ctx)
	require.NoError(t, err)

	store := platformstore.New(handle.Client, platformstore.WithFieldCipher(cipher))

	items, _, err := store.ListAccounts(ctx, platformadmin.AccountQuery{SiteID: siteRow.ID}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "alice@example.com", items[0].Email,
		"the platform directory must show the address, not its envelope")

	byEmail, _, err := store.ListAccounts(ctx,
		platformadmin.AccountQuery{SiteID: siteRow.ID, Search: "alice@"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byEmail, 1, "an exact address search must resolve a sealed column")

	byPartial, _, err := store.ListAccounts(ctx,
		platformadmin.AccountQuery{SiteID: siteRow.ID, Search: "alice"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byPartial, 1, "a partial address search must decrypt a bounded page and match")

	missing, _, err := store.ListAccounts(ctx,
		platformadmin.AccountQuery{SiteID: siteRow.ID, Search: "nobody"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Empty(t, missing)

	// A different key must fail rather than render the envelope as an address.
	otherKey := make([]byte, 32)
	otherKey[0] = 0xff
	other, err := fieldcrypto.New(otherKey)
	require.NoError(t, err)
	otherStore := platformstore.New(handle.Client, platformstore.WithFieldCipher(other))
	_, _, err = otherStore.ListAccounts(ctx, platformadmin.AccountQuery{SiteID: siteRow.ID}, 50, page.Cursor{})
	require.Error(t, err)
}
