package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

func devConfig(t *testing.T) config.Config {
	t.Helper()
	return config.Config{
		AppEnv:        config.EnvTest,
		AuthJWTIssuer: "test-issuer",
	}
}

func newTestIssuer(t *testing.T) *TokenIssuer {
	t.Helper()
	issuer, ephemeral, err := NewTokenIssuer(devConfig(t))
	require.NoError(t, err)
	require.True(t, ephemeral, "no key configured must fall back to an ephemeral key")
	return issuer
}

func testPrincipal() Principal {
	return Principal{UserID: "user_1", SiteID: "site_1", Role: site.RoleEditor}
}

func TestIssueAndVerifyAccessRoundTrip(t *testing.T) {
	issuer := newTestIssuer(t)

	token, expiresAt, err := issuer.IssueAccess(testPrincipal())
	require.NoError(t, err)
	require.NotEmpty(t, token)
	require.WithinDuration(t, time.Now().UTC().Add(AccessTTL), expiresAt, 5*time.Second)

	got, err := issuer.VerifyAccess(token)
	require.NoError(t, err)
	require.Equal(t, testPrincipal(), got)
}

func TestAccessTokenCarriesKeyIDAndIssuer(t *testing.T) {
	issuer := newTestIssuer(t)

	token, _, err := issuer.IssueAccess(testPrincipal())
	require.NoError(t, err)

	parsed, _, err := jwt.NewParser().ParseUnverified(token, jwt.MapClaims{})
	require.NoError(t, err)
	require.Equal(t, issuer.KeyID(), parsed.Header["kid"])
	require.Equal(t, "test-issuer", parsed.Claims.(jwt.MapClaims)["iss"])
}

func TestVerifyAccessRejectsExpired(t *testing.T) {
	issuer := newTestIssuer(t)
	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	issuer.now = func() time.Time { return base }

	token, _, err := issuer.IssueAccess(testPrincipal())
	require.NoError(t, err)

	issuer.now = func() time.Time { return base.Add(AccessTTL + clockSkew + time.Minute) }
	_, err = issuer.VerifyAccess(token)
	require.ErrorIs(t, err, ErrTokenExpired)
}

func TestVerifyAccessRejectsForeignKey(t *testing.T) {
	issuer := newTestIssuer(t)
	other := newTestIssuer(t)

	token, _, err := other.IssueAccess(testPrincipal())
	require.NoError(t, err)

	_, err = issuer.VerifyAccess(token)
	require.ErrorIs(t, err, ErrInvalidToken)
}

func TestVerifyAccessRejectsAlgNone(t *testing.T) {
	issuer := newTestIssuer(t)

	forged := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{
		"sub":  "attacker",
		"sid":  "site_1",
		"role": string(site.RolePlatformAdmin),
		"iss":  "test-issuer",
		"exp":  time.Now().Add(time.Hour).Unix(),
	})
	raw, err := forged.SignedString(jwt.UnsafeAllowNoneSignatureType)
	require.NoError(t, err)

	_, err = issuer.VerifyAccess(raw)
	require.ErrorIs(t, err, ErrInvalidToken)
}

func TestVerifyAccessRejectsGarbage(t *testing.T) {
	issuer := newTestIssuer(t)
	for _, raw := range []string{"", "not-a-token", "a.b.c", strings.Repeat("x", 500)} {
		_, err := issuer.VerifyAccess(raw)
		require.ErrorIs(t, err, ErrInvalidToken, raw)
	}
}

func TestVerifyAccessRejectsUnknownRole(t *testing.T) {
	issuer := newTestIssuer(t)

	forged := jwt.NewWithClaims(signingMethod, jwt.MapClaims{
		"sub":  "user_1",
		"sid":  "site_1",
		"role": "superuser",
		"iss":  "test-issuer",
		"exp":  time.Now().Add(time.Hour).Unix(),
	})
	forged.Header["kid"] = issuer.KeyID()
	raw, err := forged.SignedString(issuer.key)
	require.NoError(t, err)

	_, err = issuer.VerifyAccess(raw)
	require.ErrorIs(t, err, ErrInvalidToken)
}

func TestIssueAccessRejectsIncompletePrincipal(t *testing.T) {
	issuer := newTestIssuer(t)

	_, _, err := issuer.IssueAccess(Principal{UserID: "user_1", SiteID: "site_1"})
	require.Error(t, err, "role must be valid")

	_, _, err = issuer.IssueAccess(Principal{UserID: "user_1", Role: site.RoleMember})
	require.Error(t, err, "site must be present")
}

func TestProductionRequiresConfiguredKey(t *testing.T) {
	cfg := config.Config{AppEnv: config.EnvProduction, AuthJWTIssuer: "test-issuer"}

	_, _, err := NewTokenIssuer(cfg)
	require.Error(t, err)
	require.Contains(t, err.Error(), "AUTH_JWT_ED25519_PRIVATE_KEY")
}

func TestConfiguredKeyIsUsedAndNotEphemeral(t *testing.T) {
	key, err := GenerateSigningKey()
	require.NoError(t, err)
	encoded, err := EncodeSigningKey(key)
	require.NoError(t, err)

	cfg := config.Config{
		AppEnv:            config.EnvProduction,
		AuthJWTPrivateKey: encoded,
		AuthJWTKeyID:      "kid-1",
		AuthJWTIssuer:     "test-issuer",
	}

	issuer, ephemeral, err := NewTokenIssuer(cfg)
	require.NoError(t, err)
	require.False(t, ephemeral)
	require.Equal(t, "kid-1", issuer.KeyID())

	token, _, err := issuer.IssueAccess(testPrincipal())
	require.NoError(t, err)

	// A second instance built from the same key must verify it: this is what makes
	// a multi replica deployment work.
	second, _, err := NewTokenIssuer(cfg)
	require.NoError(t, err)
	_, err = second.VerifyAccess(token)
	require.NoError(t, err)
}

func TestInvalidConfiguredKeyIsRejected(t *testing.T) {
	for _, bad := range []string{"not base64!!", "AAAA"} {
		_, _, err := NewTokenIssuer(config.Config{
			AppEnv:            config.EnvTest,
			AuthJWTPrivateKey: bad,
		})
		require.Error(t, err, bad)
	}
}

func TestNewRefreshTokenIsHighEntropyAndHashed(t *testing.T) {
	seen := make(map[string]struct{}, 64)

	for i := 0; i < 64; i++ {
		token, err := NewRefreshToken()
		require.NoError(t, err)
		require.NotEmpty(t, token.Plain)
		require.Len(t, token.Hash, 64, "sha256 hex")
		require.NotEqual(t, token.Plain, token.Hash, "the plain value must not be stored")
		require.Equal(t, HashOpaqueToken(token.Plain), token.Hash)

		_, dup := seen[token.Plain]
		require.False(t, dup, "refresh tokens must be unique")
		seen[token.Plain] = struct{}{}
	}
}

func TestCSRFTokensAreUnique(t *testing.T) {
	a, err := NewCSRFToken()
	require.NoError(t, err)
	b, err := NewCSRFToken()
	require.NoError(t, err)
	require.NotEqual(t, a, b)
	require.NotEmpty(t, a)
}

// TestCSRFTokenIsDerivedFromTheRefreshToken pins the V-27 derivation: deterministic for
// one refresh token, different across tokens, and long enough to compare safely.
func TestCSRFTokenIsDerivedFromTheRefreshToken(t *testing.T) {
	issuer := newTestIssuer(t)

	first, err := NewRefreshToken()
	require.NoError(t, err)
	second, err := NewRefreshToken()
	require.NoError(t, err)

	csrf := issuer.CSRFToken(first.Plain)
	require.Len(t, csrf, 43, "base64url of an HMAC-SHA256 digest")
	require.Equal(t, csrf, issuer.CSRFToken(first.Plain), "the derivation must be deterministic")
	require.NotEqual(t, csrf, issuer.CSRFToken(second.Plain),
		"a rotated refresh token must get a different CSRF token")
	require.NotEqual(t, csrf, first.Plain)

	// The derivation is keyed: another issuer (another signing key) yields another
	// value, which is what stops a client from computing it locally.
	other := newTestIssuer(t)
	require.NotEqual(t, csrf, other.CSRFToken(first.Plain))
}

func TestTokensEqualIsConstantTimeComparison(t *testing.T) {
	require.True(t, TokensEqual("abc", "abc"))
	require.False(t, TokensEqual("abc", "abd"))
	require.False(t, TokensEqual("abc", "abcd"))
	require.True(t, TokensEqual("", ""))
}
