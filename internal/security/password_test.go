package securitygo

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// cheapParams keeps the password tests fast. Verification reads the parameters
// from the PHC string, so a cheap hash still exercises the same code path.
func cheapParams() Argon2Params {
	return Argon2Params{MemoryKiB: 8 * 1024, Iterations: 1, Parallelism: 1}
}

func cheapHash(t *testing.T, plain string) string {
	t.Helper()
	encoded, err := HashPasswordWithParams(plain, cheapParams())
	require.NoError(t, err)
	return encoded
}

func TestHashPasswordProducesreferenceCompatiblePHC(t *testing.T) {
	encoded, err := HashPassword("correct horse battery")
	require.NoError(t, err)

	require.True(t, strings.HasPrefix(encoded, "$argon2id$v=19$m=65536,t=3,p=2$"),
		"the PHC prefix must match the reference implementation: %s", encoded)

	parts := strings.Split(encoded, "$")
	require.Len(t, parts, 6)
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	require.NoError(t, err)
	require.Len(t, salt, 16, "reference SaltString::generate uses a 16-byte salt")
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	require.NoError(t, err)
	require.Len(t, key, 32, "Argon2 defaults to a 32-byte output")
	require.Len(t, encoded, 97, "a default password hash has a fixed encoded length")
}

func TestHashPasswordRoundTrips(t *testing.T) {
	encoded := cheapHash(t, "correct horse battery")
	require.True(t, strings.HasPrefix(encoded, "$argon2id$"))

	matches, err := VerifyPassword("correct horse battery", encoded)
	require.NoError(t, err)
	require.True(t, matches)
}

func TestWrongPasswordIsFalseNotError(t *testing.T) {
	encoded := cheapHash(t, "correct horse battery")

	matches, err := VerifyPassword("wrong password", encoded)
	require.NoError(t, err)
	require.False(t, matches)
}

func TestHashesAreSalted(t *testing.T) {
	a := cheapHash(t, "correct horse battery")
	b := cheapHash(t, "correct horse battery")
	require.NotEqual(t, a, b, "each hash must use a fresh salt")
}

func TestHashPasswordEnforcesRuneLengthBounds(t *testing.T) {
	_, err := HashPassword("short")
	require.ErrorIs(t, err, ErrInvalidLength)

	_, err = HashPassword("")
	require.ErrorIs(t, err, ErrInvalidLength)

	_, err = HashPassword(strings.Repeat("a", MaxPasswordLength+1))
	require.ErrorIs(t, err, ErrInvalidLength)

	atMax, err := HashPasswordWithParams(strings.Repeat("a", MaxPasswordLength), cheapParams())
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(atMax, "$argon2id$"))
}

func TestBoundsAreCountedInCodePointsLikereference(t *testing.T) {
	// Eight CJK code points are 24 bytes: the byte length is over the byte
	// budget but the character count is exactly the minimum.
	eight := "密码密码密码密码"
	require.Equal(t, MinPasswordLength, len([]rune(eight)))
	require.True(t, PlaintextWithinBounds(eight))
	require.False(t, PlaintextWithinBounds("密码密码密码"))

	require.True(t, PlaintextWithinBounds(strings.Repeat("密", MaxPasswordLength)))
	require.False(t, PlaintextWithinBounds(strings.Repeat("密", MaxPasswordLength+1)))

	require.False(t, PlaintextWithinBounds(""))
	require.False(t, PlaintextWithinBounds("short"))
	require.True(t, PlaintextWithinBounds("exactly8"))
}

func TestVerifyRejectsOversizedInputsBeforeHashing(t *testing.T) {
	encoded := cheapHash(t, "correct horse battery")

	// Out-of-range plaintexts are a plain mismatch, never an error.
	matches, err := VerifyPassword(strings.Repeat("a", MaxPasswordLength+1), encoded)
	require.NoError(t, err)
	require.False(t, matches)

	matches, err = VerifyPassword("short", encoded)
	require.NoError(t, err)
	require.False(t, matches)

	// A megabyte of attacker input must be refused before Argon2 sees it.
	matches, err = VerifyPassword(strings.Repeat("a", 1024*1024), encoded)
	require.NoError(t, err)
	require.False(t, matches)
}

func TestVerifyRejectsMalformedEncoded(t *testing.T) {
	for _, encoded := range []string{
		"",
		"   \t\n",
		"$argon2id$not-really",
		"$argon2id$v=19$m=8192,t=1,p=1$not-base64!$AAAA",
		"not-a-phc-string",
		"$argon2id$v=19$m=8192,t=1,p=1$c29tZXNhbHQ", // missing hash field
	} {
		matches, err := VerifyPassword("correct horse battery", encoded)
		require.ErrorIs(t, err, ErrInvalidHash, "encoded %q", encoded)
		require.False(t, matches, "encoded %q", encoded)
	}
}

func TestVerifyRejectsOversizedEncoded(t *testing.T) {
	oversized := "$argon2id$v=19$m=8192,t=1,p=1$" + strings.Repeat("A", MaxEncodedPasswordLength)
	require.Greater(t, len(oversized), MaxEncodedPasswordLength)

	_, err := VerifyPassword("correct horse battery", oversized)
	require.ErrorIs(t, err, ErrInvalidHash)
}

func TestVerifyAcceptsreferenceArgon2CrateTestVector(t *testing.T) {
	// From the argon2 crate's tests/phc_strings.rs (adapted from the reference
	// implementation's test vectors). reference's argon2 0.5 verifier accepts it, and
	// so must ours: this is the PHC compatibility contract.
	const encoded = "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc"

	matches, err := VerifyPassword("password", encoded)
	require.NoError(t, err)
	require.True(t, matches, "the reference Argon2id vector must verify")

	matches, err = VerifyPassword("sassword", encoded)
	require.NoError(t, err)
	require.False(t, matches)
}

func TestVerifyAcceptsCapturedreferenceServiceHash(t *testing.T) {
	// Captured from the previous sidecar during the
	// Go-first rollout verification: HashPassword("correct horse battery").
	const encoded = "$argon2id$v=19$m=65536,t=3,p=2$EYKj8Ww9yXvsPVGOTx4YPw$lxF+MwcGn7GR3zVB2apC0eY2fvde7NmbUwaKS6opg80"

	matches, err := VerifyPassword("correct horse battery", encoded)
	require.NoError(t, err)
	require.True(t, matches, "hashes written by the previous sidecar must verify in Go")

	matches, err = VerifyPassword("wrong password", encoded)
	require.NoError(t, err)
	require.False(t, matches)
}

func TestVerifyTreatsUnsupportedHashesAsMismatch(t *testing.T) {
	// The reference verifier derives the default 32-byte key, so a hash with another
	// length can never match there either.
	shortKey := "$argon2id$v=19$m=8192,t=1,p=1$c29tZXNhbHQ$" +
		base64.RawStdEncoding.EncodeToString([]byte("0123456789abcdef"))
	matches, err := VerifyPassword("correct horse battery", shortKey)
	require.NoError(t, err)
	require.False(t, matches)

	// Argon2i and Argon2d hashes are not reproduced by x/crypto/argon2; the
	// service reports a mismatch instead of claiming a match.
	for _, algorithm := range []string{"argon2i", "argon2d"} {
		encoded := "$" + algorithm + "$v=19$m=8192,t=1,p=1$c29tZXNhbHQ$" +
			base64.RawStdEncoding.EncodeToString(make([]byte, 32))
		matches, err := VerifyPassword("password", encoded)
		require.NoError(t, err, algorithm)
		require.False(t, matches, algorithm)
	}

	// A structurally valid but unusable parameter set is a mismatch, not an
	// unusable-hash error.
	badParams := "$argon2id$v=19$m=0,t=1,p=1$c29tZXNhbHQ$" +
		base64.RawStdEncoding.EncodeToString(make([]byte, 32))
	matches, err = VerifyPassword("password", badParams)
	require.NoError(t, err)
	require.False(t, matches)
}

func TestHashWithFixedSaltIsDeterministic(t *testing.T) {
	salt := make([]byte, 16)
	for i := range salt {
		salt[i] = byte(i)
	}

	first, err := hashWithSalt("correct horse battery", salt, cheapParams())
	require.NoError(t, err)
	second, err := hashWithSalt("correct horse battery", salt, cheapParams())
	require.NoError(t, err)
	require.Equal(t, first, second, "the same salt and parameters must produce the same PHC string")

	matches, err := VerifyPassword("correct horse battery", first)
	require.NoError(t, err)
	require.True(t, matches)
}

func TestHashPasswordWithInvalidParamsFails(t *testing.T) {
	_, err := HashPasswordWithParams("correct horse battery", Argon2Params{
		MemoryKiB: 4, Iterations: 1, Parallelism: 8,
	})
	require.ErrorIs(t, err, ErrHashFailed)
}

func TestEncodedWithinBoundsMatchesreferenceRules(t *testing.T) {
	encoded := cheapHash(t, "correct horse battery")
	require.True(t, EncodedWithinBounds(encoded))
	require.False(t, EncodedWithinBounds(""))
	require.False(t, EncodedWithinBounds("   "))
	require.False(t, EncodedWithinBounds(strings.Repeat("A", MaxEncodedPasswordLength+1)))
}

func TestErrorsAreDistinct(t *testing.T) {
	require.False(t, errors.Is(ErrInvalidLength, ErrInvalidHash))
	require.Equal(t, "password length is out of range", ErrInvalidLength.Error())
	require.Equal(t, "stored password hash is invalid", ErrInvalidHash.Error())
}
