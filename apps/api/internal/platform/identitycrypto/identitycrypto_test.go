package identitycrypto_test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/fieldcrypto"
	"github.com/practacu/practacu-press/apps/api/internal/platform/identitycrypto"
)

func testCodec(t *testing.T) *identitycrypto.Codec {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 11)
	}
	cipher, err := fieldcrypto.New(key)
	require.NoError(t, err)
	return identitycrypto.New(cipher)
}

func TestNilCodecIsPlaintext(t *testing.T) {
	var codec *identitycrypto.Codec
	require.False(t, codec.Enabled())

	sealed, err := codec.SealEmail("Alice@Example.com")
	require.NoError(t, err)
	require.Equal(t, "Alice@Example.com", sealed)

	opened, err := codec.OpenEmail(sealed)
	require.NoError(t, err)
	require.Equal(t, "Alice@Example.com", opened)
}

func TestSealSubjectIsDeterministicAndCaseFolded(t *testing.T) {
	codec := testCodec(t)

	first, err := codec.SealSubject("email", "Alice@Example.com")
	require.NoError(t, err)
	second, err := codec.SealSubject("email", " alice@example.com ")
	require.NoError(t, err)
	require.Equal(t, first, second, "case and whitespace must fold to the same envelope")
	require.True(t, strings.HasPrefix(first, "d1:"))
	require.False(t, identitycrypto.IsSealed("alice@example.com"))

	opened, err := codec.OpenSubject("email", first)
	require.NoError(t, err)
	require.Equal(t, "alice@example.com", opened)
}

func TestOAuthSubjectStaysPlaintext(t *testing.T) {
	codec := testCodec(t)
	sealed, err := codec.SealSubject("github", "4242")
	require.NoError(t, err)
	require.Equal(t, "4242", sealed)

	opened, err := codec.OpenSubject("github", sealed)
	require.NoError(t, err)
	require.Equal(t, "4242", opened)
}

func TestPhoneIsSealed(t *testing.T) {
	codec := testCodec(t)
	sealed, err := codec.SealPhone("+86 138 0000 0000")
	require.NoError(t, err)
	require.True(t, identitycrypto.IsSealed(sealed))

	opened, err := codec.OpenPhone(sealed)
	require.NoError(t, err)
	require.Equal(t, "+86 138 0000 0000", opened)
}

func TestPurposeSeparation(t *testing.T) {
	codec := testCodec(t)
	sealed, err := codec.SealEmail("alice@example.com")
	require.NoError(t, err)

	// The mirrored email column must not open as a provider subject and vice versa.
	_, err = codec.OpenSubject("email", sealed)
	require.ErrorIs(t, err, fieldcrypto.ErrInvalidEnvelope)
}

func TestEmptyValuePassesThrough(t *testing.T) {
	codec := testCodec(t)
	opened, err := codec.OpenEmail("")
	require.NoError(t, err)
	require.Equal(t, "", opened)
}
