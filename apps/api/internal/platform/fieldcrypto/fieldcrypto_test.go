package fieldcrypto_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/fieldcrypto"
)

func testKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	return key
}

func TestSealRoundTrip(t *testing.T) {
	cipher, err := fieldcrypto.New(testKey(t))
	require.NoError(t, err)

	sealed, err := cipher.Seal("alice@example.com", "identity.email")
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(sealed, "v1:"))
	require.True(t, fieldcrypto.IsSealed(sealed))

	plain, wasSealed, err := cipher.OpenOrPlain(sealed, "identity.email")
	require.NoError(t, err)
	require.True(t, wasSealed)
	require.Equal(t, "alice@example.com", plain)
}

func TestRandomSealIsNotDeterministic(t *testing.T) {
	cipher, err := fieldcrypto.New(testKey(t))
	require.NoError(t, err)

	first, err := cipher.Seal("same", "purpose")
	require.NoError(t, err)
	second, err := cipher.Seal("same", "purpose")
	require.NoError(t, err)
	require.NotEqual(t, first, second, "a random nonce must not repeat")
}

func TestDeterministicSealMatchesAcrossCalls(t *testing.T) {
	cipher, err := fieldcrypto.New(testKey(t))
	require.NoError(t, err)

	first, err := cipher.SealDeterministic("alice@example.com", "identity.email")
	require.NoError(t, err)
	second, err := cipher.SealDeterministic("alice@example.com", "identity.email")
	require.NoError(t, err)
	require.Equal(t, first, second)
	require.True(t, strings.HasPrefix(first, "d1:"))

	other, err := cipher.SealDeterministic("bob@example.com", "identity.email")
	require.NoError(t, err)
	require.NotEqual(t, first, other)
}

func TestPurposeBinding(t *testing.T) {
	cipher, err := fieldcrypto.New(testKey(t))
	require.NoError(t, err)

	sealed, err := cipher.SealDeterministic("alice@example.com", "identity.email")
	require.NoError(t, err)

	_, err = cipher.Open(sealed, "identity.phone")
	require.ErrorIs(t, err, fieldcrypto.ErrInvalidEnvelope,
		"a ciphertext must not open under a different purpose")
}

func TestWrongKeyFails(t *testing.T) {
	cipher, err := fieldcrypto.New(testKey(t))
	require.NoError(t, err)
	sealed, err := cipher.Seal("secret", "purpose")
	require.NoError(t, err)

	other := testKey(t)
	other[0] ^= 0xff
	second, err := fieldcrypto.New(other)
	require.NoError(t, err)

	_, err = second.Open(sealed, "purpose")
	require.ErrorIs(t, err, fieldcrypto.ErrInvalidEnvelope)
}

func TestTamperingFails(t *testing.T) {
	cipher, err := fieldcrypto.New(testKey(t))
	require.NoError(t, err)
	sealed, err := cipher.Seal("secret", "purpose")
	require.NoError(t, err)

	tampered := sealed[:len(sealed)-2] + "AA"
	if tampered == sealed {
		tampered = sealed[:len(sealed)-2] + "BB"
	}
	_, err = cipher.Open(tampered, "purpose")
	require.ErrorIs(t, err, fieldcrypto.ErrInvalidEnvelope)

	_, err = cipher.Open("v1:not-base64!", "purpose")
	require.ErrorIs(t, err, fieldcrypto.ErrInvalidEnvelope)

	_, err = cipher.Open("v1:", "purpose")
	require.ErrorIs(t, err, fieldcrypto.ErrInvalidEnvelope)
}

func TestOpenOrPlainPassesLegacyValuesThrough(t *testing.T) {
	cipher, err := fieldcrypto.New(testKey(t))
	require.NoError(t, err)

	plain, wasSealed, err := cipher.OpenOrPlain("legacy@example.com", "identity.email")
	require.NoError(t, err)
	require.False(t, wasSealed)
	require.Equal(t, "legacy@example.com", plain)
}

func TestDecodeKey(t *testing.T) {
	key := testKey(t)
	padded := "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="
	raw := "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"

	got, err := fieldcrypto.DecodeKey(padded)
	require.NoError(t, err)
	require.Equal(t, key, got)

	got, err = fieldcrypto.DecodeKey(raw)
	require.NoError(t, err)
	require.Equal(t, key, got)

	_, err = fieldcrypto.DecodeKey("dGlueQ==")
	require.Error(t, err)
	_, err = fieldcrypto.DecodeKey("")
	require.Error(t, err)
	_, err = fieldcrypto.DecodeKey("not base64!!")
	require.Error(t, err)
}

func TestFromSeedIsStableAndPurposeSeparated(t *testing.T) {
	seed := []byte("signing seed material")
	first, err := fieldcrypto.FromSeed(seed, "a")
	require.NoError(t, err)
	second, err := fieldcrypto.FromSeed(seed, "a")
	require.NoError(t, err)
	third, err := fieldcrypto.FromSeed(seed, "b")
	require.NoError(t, err)

	one, err := first.Seal("value", "purpose")
	require.NoError(t, err)
	_, err = second.Open(one, "purpose")
	require.NoError(t, err)
	_, err = third.Open(one, "purpose")
	require.ErrorIs(t, err, fieldcrypto.ErrInvalidEnvelope)

	_, err = fieldcrypto.FromSeed(nil, "")
	require.Error(t, err)
}

func TestLoadOrCreateKeyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "field.key")

	first, err := fieldcrypto.LoadOrCreateKeyFile(path)
	require.NoError(t, err)
	require.Len(t, first, 32)

	info, err := os.Stat(path)
	require.NoError(t, err)
	require.False(t, info.IsDir())

	second, err := fieldcrypto.LoadOrCreateKeyFile(path)
	require.NoError(t, err)
	require.Equal(t, first, second, "the key must survive a restart")

	cipher, err := fieldcrypto.New(first)
	require.NoError(t, err)
	sealed, err := cipher.Seal("x", "p")
	require.NoError(t, err)
	other, err := fieldcrypto.New(second)
	require.NoError(t, err)
	_, err = other.Open(sealed, "p")
	require.NoError(t, err)
}

func TestNewRejectsWrongKeySize(t *testing.T) {
	_, err := fieldcrypto.New(make([]byte, 16))
	require.Error(t, err)
	_, err = fieldcrypto.New(nil)
	require.Error(t, err)
}
