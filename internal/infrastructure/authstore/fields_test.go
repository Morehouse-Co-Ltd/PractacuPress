package authstore_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/platform/fieldcrypto"

	"github.com/practacu/practacu-press/internal/ent/useridentity"
)

func testCipher(t *testing.T) *fieldcrypto.Cipher {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i*7 + 3)
	}
	cipher, err := fieldcrypto.New(key)
	require.NoError(t, err)
	return cipher
}

func TestRegisterSealsIdentityColumns(t *testing.T) {
	ctx := context.Background()
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "sealed.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	cipher := testCipher(t)
	issuer, _, err := auth.NewTokenIssuer(config.Config{
		AppEnv:        config.EnvTest,
		AuthJWTIssuer: "test-issuer",
	})
	require.NoError(t, err)
	store := authstore.New(handle.Client, authstore.WithFieldCipher(cipher))
	service, err := auth.NewService(auth.ServiceConfig{
		Repository: store,
		Hasher: auth.NewArgon2idHasher(auth.Argon2Params{
			Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32,
		}),
		Tokens: issuer,
	})
	require.NoError(t, err)

	session, err := service.RegisterEmail(ctx, siteRow.ID, auth.RegisterEmailInput{
		Email:       "Alice@Example.com",
		Password:    "correct horse battery",
		DisplayName: "Alice",
	})
	require.NoError(t, err)
	require.Equal(t, "Alice", session.User.DisplayName)

	row, err := handle.Client.UserIdentity.Query().
		Where(useridentity.ProviderEQ("email")).
		Only(ctx)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(row.ProviderSubject, "d1:"),
		"the login subject must be sealed at rest, got %q", row.ProviderSubject)
	require.NotNil(t, row.Email)
	require.True(t, strings.HasPrefix(*row.Email, "d1:"),
		"the mirrored address must be sealed at rest, got %q", *row.Email)
	require.NotContains(t, row.ProviderSubject, "alice@example.com")

	// The lookup decrypts, and login still resolves the account.
	identity, err := store.FindEmailIdentity(ctx, "alice@example.com")
	require.NoError(t, err)
	require.Equal(t, "alice@example.com", identity.Subject)
	require.Equal(t, "alice@example.com", identity.Email)

	_, err = service.LoginPassword(ctx, siteRow.ID, auth.LoginInput{
		Identifier: "alice@example.com",
		Password:   "correct horse battery",
	})
	require.NoError(t, err)
}

func TestFindEmailIdentityUpgradesLegacyPlaintextRow(t *testing.T) {
	ctx := context.Background()
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "legacy.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	account, err := handle.Client.User.Create().SetDisplayName("Legacy").Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.UserIdentity.Create().
		SetUserID(account.ID).
		SetProvider("email").
		SetProviderSubject("legacy@example.com").
		SetEmail("legacy@example.com").
		SetPasswordHash("$argon2id$placeholder").
		Save(ctx)
	require.NoError(t, err)

	cipher := testCipher(t)
	store := authstore.New(handle.Client, authstore.WithFieldCipher(cipher))

	identity, err := store.FindEmailIdentity(ctx, "legacy@example.com")
	require.NoError(t, err)
	require.Equal(t, "legacy@example.com", identity.Email)

	upgraded, err := handle.Client.UserIdentity.Query().
		Where(useridentity.UserIDEQ(account.ID)).
		Only(ctx)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(upgraded.ProviderSubject, "d1:"),
		"the first read must migrate the row, got %q", upgraded.ProviderSubject)
	require.NotNil(t, upgraded.Email)
	require.True(t, strings.HasPrefix(*upgraded.Email, "d1:"))
}

func TestBackfillIdentityEncryptionIsIdempotent(t *testing.T) {
	ctx := context.Background()
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "backfill.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	for _, address := range []string{"one@example.com", "two@example.com"} {
		account, err := handle.Client.User.Create().SetDisplayName(address).Save(ctx)
		require.NoError(t, err)
		_, err = handle.Client.UserIdentity.Create().
			SetUserID(account.ID).
			SetProvider("email").
			SetProviderSubject(address).
			SetEmail(address).
			SetPasswordHash("$argon2id$placeholder").
			Save(ctx)
		require.NoError(t, err)
	}

	cipher := testCipher(t)
	first, err := authstore.BackfillIdentityEncryption(ctx, handle.Client, cipher)
	require.NoError(t, err)
	require.Equal(t, 2, first.Sealed)
	require.Empty(t, first.Warnings)

	second, err := authstore.BackfillIdentityEncryption(ctx, handle.Client, cipher)
	require.NoError(t, err)
	require.Equal(t, 0, second.Sealed, "a second run must change nothing")

	_, err = authstore.BackfillIdentityEncryption(ctx, handle.Client, nil)
	require.Error(t, err)
}

func TestSealedIdentityRejectsAnotherKey(t *testing.T) {
	ctx := context.Background()
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "wrongkey.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	account, err := handle.Client.User.Create().SetDisplayName("Sealed").Save(ctx)
	require.NoError(t, err)
	cipher := testCipher(t)
	sealed, err := cipher.SealDeterministic("sealed@example.com", "user-identity.subject.email")
	require.NoError(t, err)
	sealedEmail, err := cipher.SealDeterministic("sealed@example.com", "user-identity.email")
	require.NoError(t, err)
	_, err = handle.Client.UserIdentity.Create().
		SetUserID(account.ID).
		SetProvider("email").
		SetProviderSubject(sealed).
		SetEmail(sealedEmail).
		Save(ctx)
	require.NoError(t, err)

	// Another key must fail loudly instead of returning the envelope as an address.
	otherKey := make([]byte, 32)
	otherKey[0] = 0x99
	other, err := fieldcrypto.New(otherKey)
	require.NoError(t, err)
	store := authstore.New(handle.Client, authstore.WithFieldCipher(other))
	_, err = store.FindEmailIdentity(ctx, "sealed@example.com")
	require.Error(t, err)
}
