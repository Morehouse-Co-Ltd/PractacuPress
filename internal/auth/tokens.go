package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/site"
)

// Token lifetimes.
const (
	// AccessTTL is deliberately short: the access token is kept in browser memory
	// and is not revocable, so a short window bounds the damage of theft.
	AccessTTL = 15 * time.Minute
	// RefreshTTL is the idle lifetime of one refresh token. Rotation issues a new
	// token with a fresh idle deadline.
	RefreshTTL = 30 * 24 * time.Hour
	// RefreshFamilyAbsoluteTTL is the hard ceiling on a refresh lineage, no matter how
	// often it rotates. Without it a stolen refresh cookie could be kept alive forever
	// by refreshing it inside every idle window.
	RefreshFamilyAbsoluteTTL = 90 * 24 * time.Hour
	// RefreshTokenBytes is the entropy of an opaque refresh token.
	RefreshTokenBytes = 32
	// CSRFTokenBytes is the entropy of the double submit CSRF token.
	CSRFTokenBytes = 32
	// clockSkew tolerates small clock differences when validating iat.
	clockSkew = 30 * time.Second
)

// SigningMethod is the only accepted JWT algorithm. Pinning it is what prevents an
// attacker from swapping in "none" or an HMAC algorithm.
var signingMethod = jwt.SigningMethodEdDSA

// TokenIssuer mints and verifies Ed25519 signed access tokens.
type TokenIssuer struct {
	key       ed25519.PrivateKey
	keyID     string
	issuer    string
	accessTTL time.Duration
	now       func() time.Time
}

// NewTokenIssuer builds an issuer from configuration.
//
// The second return value reports that an ephemeral key was generated because none
// was configured. Callers must log that loudly in anything but development: tokens
// signed with an ephemeral key die with the process and cannot be verified by a
// second replica.
func NewTokenIssuer(cfg config.Config) (*TokenIssuer, bool, error) {
	now := func() time.Time { return time.Now().UTC() }

	key, ephemeral, err := loadSigningKey(cfg)
	if err != nil {
		return nil, false, err
	}

	keyID := cfg.AuthJWTKeyID
	if keyID == "" {
		keyID = keyIDFor(key.Public().(ed25519.PublicKey))
	}

	issuer := cfg.AuthJWTIssuer
	if issuer == "" {
		issuer = config.DefaultJWTIssuer
	}

	return &TokenIssuer{
		key:       key,
		keyID:     keyID,
		issuer:    issuer,
		accessTTL: AccessTTL,
		now:       now,
	}, ephemeral, nil
}

// KeyID returns the identifier stamped into every token header.
func (i *TokenIssuer) KeyID() string { return i.keyID }

// GenerateSigningKey returns a new Ed25519 signing key.
//
// It exists so an operator (and the test suite) can mint a key without hand rolling
// key generation, which is where algorithm choices usually go wrong.
func GenerateSigningKey() (ed25519.PrivateKey, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("auth: generate signing key: %w", err)
	}
	return key, nil
}

// EncodeSigningKey renders a private key as the base64 PKCS#8 value that
// AUTH_JWT_ED25519_PRIVATE_KEY expects.
func EncodeSigningKey(key ed25519.PrivateKey) (string, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", fmt.Errorf("auth: encode signing key: %w", err)
	}
	return base64.StdEncoding.EncodeToString(der), nil
}

func loadSigningKey(cfg config.Config) (ed25519.PrivateKey, bool, error) {
	if cfg.AuthJWTPrivateKey == "" {
		if cfg.AppEnv == config.EnvProduction {
			return nil, false, fmt.Errorf(
				"auth: AUTH_JWT_ED25519_PRIVATE_KEY is required when APP_ENV=production")
		}
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, false, fmt.Errorf("auth: generate ephemeral signing key: %w", err)
		}
		return key, true, nil
	}

	raw, err := base64.StdEncoding.DecodeString(cfg.AuthJWTPrivateKey)
	if err != nil {
		return nil, false, fmt.Errorf("auth: AUTH_JWT_ED25519_PRIVATE_KEY is not valid base64: %w", err)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(raw)
	if err != nil {
		return nil, false, fmt.Errorf("auth: AUTH_JWT_ED25519_PRIVATE_KEY is not PKCS#8: %w", err)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, false, fmt.Errorf("auth: AUTH_JWT_ED25519_PRIVATE_KEY is not an Ed25519 key")
	}
	return key, false, nil
}

func keyIDFor(public ed25519.PublicKey) string {
	sum := sha256.Sum256(public)
	return hex.EncodeToString(sum[:8])
}

// IssueAccess mints a short lived access token for one principal.
func (i *TokenIssuer) IssueAccess(principal Principal) (string, time.Time, error) {
	if principal.UserID == "" || principal.SiteID == "" {
		return "", time.Time{}, fmt.Errorf("auth: principal must carry user and site")
	}
	if !principal.Role.Valid() {
		return "", time.Time{}, fmt.Errorf("auth: principal role %q is not valid", principal.Role)
	}

	now := i.now()
	expiresAt := now.Add(i.accessTTL)

	token := jwt.NewWithClaims(signingMethod, jwt.MapClaims{
		"sub":  principal.UserID,
		"sid":  principal.SiteID,
		"role": string(principal.Role),
		"iss":  i.issuer,
		"iat":  now.Unix(),
		"nbf":  now.Unix(),
		"exp":  expiresAt.Unix(),
		"jti":  uuid.Must(uuid.NewV7()).String(),
	})
	token.Header["kid"] = i.keyID

	signed, err := token.SignedString(i.key)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("auth: sign access token: %w", err)
	}
	return signed, expiresAt, nil
}

// VerifyAccess validates an access token and returns the principal it carries.
//
// The algorithm and key id are both pinned: accepting any algorithm or an unknown
// key id is how signature bypass bugs happen.
func (i *TokenIssuer) VerifyAccess(raw string) (Principal, error) {
	claims := jwt.MapClaims{}
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{signingMethod.Alg()}),
		jwt.WithIssuer(i.issuer),
		jwt.WithLeeway(clockSkew),
	)

	_, err := parser.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" || kid != i.keyID {
			return nil, fmt.Errorf("auth: unexpected key id")
		}
		return i.key.Public(), nil
	})
	if err != nil {
		return Principal{}, mapJWTError(err)
	}

	principal := Principal{
		UserID: claimString(claims, "sub"),
		SiteID: claimString(claims, "sid"),
		Role:   site.Role(claimString(claims, "role")),
	}
	if principal.UserID == "" || principal.SiteID == "" || !principal.Role.Valid() {
		return Principal{}, ErrInvalidToken
	}
	return principal, nil
}

// SiteSwitchTTL bounds how long a handoff token may be redeemed.
//
// The token exists to move one account from the platform console to the target site's
// own origin, where it is exchanged for a real session. Two minutes is long enough for a
// browser redirect and far too short to be a useful stolen credential; the token is also
// useless as an access token because it carries no role claim.
const SiteSwitchTTL = 2 * time.Minute

// siteSwitchPurpose is the claim that separates a handoff token from an access token.
const siteSwitchPurpose = "site_switch"

// IssueSiteSwitch mints a short lived, single purpose handoff token.
func (i *TokenIssuer) IssueSiteSwitch(userID, siteID string) (string, time.Time, error) {
	if userID == "" || siteID == "" {
		return "", time.Time{}, fmt.Errorf("auth: site switch token must carry user and site")
	}

	now := i.now()
	expiresAt := now.Add(SiteSwitchTTL)
	token := jwt.NewWithClaims(signingMethod, jwt.MapClaims{
		"sub":     userID,
		"sid":     siteID,
		"purpose": siteSwitchPurpose,
		"iss":     i.issuer,
		"iat":     now.Unix(),
		"nbf":     now.Unix(),
		"exp":     expiresAt.Unix(),
		"jti":     uuid.Must(uuid.NewV7()).String(),
	})
	token.Header["kid"] = i.keyID

	signed, err := token.SignedString(i.key)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("auth: sign site switch token: %w", err)
	}
	return signed, expiresAt, nil
}

// VerifySiteSwitch validates a handoff token and returns the account and target site.
//
// The purpose claim is mandatory: an ordinary access token (which has no purpose claim)
// is rejected here, so a console session cannot be replayed as a handoff.
func (i *TokenIssuer) VerifySiteSwitch(raw string) (userID, siteID string, err error) {
	claims := jwt.MapClaims{}
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{signingMethod.Alg()}),
		jwt.WithIssuer(i.issuer),
		jwt.WithLeeway(clockSkew),
	)
	if _, err := parser.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" || kid != i.keyID {
			return nil, fmt.Errorf("auth: unexpected key id")
		}
		return i.key.Public(), nil
	}); err != nil {
		return "", "", mapJWTError(err)
	}

	if claimString(claims, "purpose") != siteSwitchPurpose {
		return "", "", ErrInvalidToken
	}
	userID = claimString(claims, "sub")
	siteID = claimString(claims, "sid")
	if userID == "" || siteID == "" {
		return "", "", ErrInvalidToken
	}
	return userID, siteID, nil
}

// TwoFactorChallengeTTL bounds the second login step (FSD F-04).
//
// Five minutes is long enough to open an authenticator app and type six digits, and
// short enough that a phished challenge token is useless by the time it is relayed.
const TwoFactorChallengeTTL = 5 * time.Minute

// TwoFactorChallengePurpose is the claim that separates a challenge token from an
// access token. It is exported so tests and clients can name it.
const TwoFactorChallengePurpose = "2fa_challenge"

// TwoFactorChallenge is the short lived, single use credential a password login of
// a 2FA protected account returns instead of a session.
//
// The token carries no role claim, so VerifyAccess rejects it: it cannot be used as
// an access token even by a client that ignores the response shape. Single use is
// enforced by the caller persisting JTI under a verification token row.
type TwoFactorChallenge struct {
	Token     string
	JTI       string
	ExpiresAt time.Time
}

// IssueTwoFactorChallenge mints the second step token for one account.
func (i *TokenIssuer) IssueTwoFactorChallenge(userID, siteID string) (TwoFactorChallenge, error) {
	if userID == "" || siteID == "" {
		return TwoFactorChallenge{}, fmt.Errorf("auth: 2fa challenge must carry user and site")
	}

	now := i.now()
	expiresAt := now.Add(TwoFactorChallengeTTL)
	jti := uuid.Must(uuid.NewV7()).String()
	token := jwt.NewWithClaims(signingMethod, jwt.MapClaims{
		"sub":     userID,
		"sid":     siteID,
		"purpose": TwoFactorChallengePurpose,
		"iss":     i.issuer,
		"iat":     now.Unix(),
		"nbf":     now.Unix(),
		"exp":     expiresAt.Unix(),
		"jti":     jti,
	})
	token.Header["kid"] = i.keyID

	signed, err := token.SignedString(i.key)
	if err != nil {
		return TwoFactorChallenge{}, fmt.Errorf("auth: sign 2fa challenge: %w", err)
	}
	return TwoFactorChallenge{Token: signed, JTI: jti, ExpiresAt: expiresAt}, nil
}

// VerifyTwoFactorChallenge validates a challenge token.
//
// Like the site handoff and the content unlock grant, the purpose claim is
// mandatory, so an ordinary access token can never be replayed as a challenge (and
// vice versa: access verification demands a valid role claim).
func (i *TokenIssuer) VerifyTwoFactorChallenge(raw string) (userID, siteID, jti string, err error) {
	claims := jwt.MapClaims{}
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{signingMethod.Alg()}),
		jwt.WithIssuer(i.issuer),
		jwt.WithLeeway(clockSkew),
	)
	if _, err := parser.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" || kid != i.keyID {
			return nil, fmt.Errorf("auth: unexpected key id")
		}
		return i.key.Public(), nil
	}); err != nil {
		return "", "", "", mapJWTError(err)
	}

	if claimString(claims, "purpose") != TwoFactorChallengePurpose {
		return "", "", "", ErrInvalidToken
	}
	userID = claimString(claims, "sub")
	siteID = claimString(claims, "sid")
	jti = claimString(claims, "jti")
	if userID == "" || siteID == "" || jti == "" {
		return "", "", "", ErrInvalidToken
	}
	return userID, siteID, jti, nil
}

// ContentUnlockTTL is how long a successful password unlock authorizes reading one
// item. It matches a working session rather than a single page view, so refreshing
// the article does not ask for the password again.
const ContentUnlockTTL = 12 * time.Hour

// contentUnlockPurpose separates an item unlock grant from every other token.
const contentUnlockPurpose = "content_unlock"

// IssueContentUnlock mints the session grant a password protected item issues after
// a correct password (C-18).
//
// The token is bound to one site and one content id and carries a purpose claim, so
// it cannot be used as an access token or replayed for another item.
func (i *TokenIssuer) IssueContentUnlock(
	_ context.Context,
	siteID, contentID string,
) (string, time.Time, error) {
	if siteID == "" || contentID == "" {
		return "", time.Time{}, fmt.Errorf("auth: content unlock token must carry site and content")
	}

	now := i.now()
	expiresAt := now.Add(ContentUnlockTTL)
	token := jwt.NewWithClaims(signingMethod, jwt.MapClaims{
		"sub":     contentID,
		"sid":     siteID,
		"cid":     contentID,
		"purpose": contentUnlockPurpose,
		"iss":     i.issuer,
		"iat":     now.Unix(),
		"nbf":     now.Unix(),
		"exp":     expiresAt.Unix(),
		"jti":     uuid.Must(uuid.NewV7()).String(),
	})
	token.Header["kid"] = i.keyID

	signed, err := token.SignedString(i.key)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("auth: sign content unlock token: %w", err)
	}
	return signed, expiresAt, nil
}

// VerifyContentUnlock reports whether raw is a valid grant for exactly this item.
//
// Every claim that scopes the grant is checked: purpose, site, content id and
// signature. A malformed or expired token is simply false, never an error the caller
// could turn into an information leak.
func (i *TokenIssuer) VerifyContentUnlock(
	_ context.Context,
	raw, siteID, contentID string,
) bool {
	if raw == "" || siteID == "" || contentID == "" {
		return false
	}
	claims := jwt.MapClaims{}
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{signingMethod.Alg()}),
		jwt.WithIssuer(i.issuer),
		jwt.WithLeeway(clockSkew),
	)
	if _, err := parser.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" || kid != i.keyID {
			return nil, fmt.Errorf("auth: unexpected key id")
		}
		return i.key.Public(), nil
	}); err != nil {
		return false
	}

	return claimString(claims, "purpose") == contentUnlockPurpose &&
		claimString(claims, "sid") == siteID &&
		claimString(claims, "sub") == contentID &&
		claimString(claims, "cid") == contentID
}

func mapJWTError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, jwt.ErrTokenExpired), strings.Contains(err.Error(), "token is expired"):
		return ErrTokenExpired
	default:
		return ErrInvalidToken
	}
}

func claimString(claims jwt.MapClaims, key string) string {
	value, _ := claims[key].(string)
	return value
}

// RefreshToken is a freshly minted opaque credential.
//
// Only Hash is persisted; Plain is returned to the client once.
type RefreshToken struct {
	Plain string
	Hash  string
}

// NewRefreshToken mints a high entropy opaque token.
func NewRefreshToken() (RefreshToken, error) {
	plain, err := randomToken(RefreshTokenBytes)
	if err != nil {
		return RefreshToken{}, err
	}
	return RefreshToken{Plain: plain, Hash: HashOpaqueToken(plain)}, nil
}

// HashOpaqueToken returns the storage form of an opaque token.
//
// A plain SHA-256 is correct here: the input already carries 256 bits of entropy,
// so there is nothing to brute force, and lookups stay index friendly.
func HashOpaqueToken(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

// csrfDerivationPrefix separates the CSRF derivation from any other use of the
// signing key as an HMAC key.
const csrfDerivationPrefix = "csrf:"

// CSRFToken derives the double submit token bound to one refresh token.
//
// The derivation is deterministic and keyed by a secret the client never sees (the
// Ed25519 seed), so:
//
//   - the same refresh token always yields the same CSRF token (the client can keep
//     using the value it read from the response or the pp_csrf cookie),
//   - a rotated refresh token yields a different one automatically, so an old CSRF
//     value dies together with its token,
//   - a cookie/header pair that was merely made to match itself is worthless, because
//     the server can recompute the expected value from the presented refresh token and
//     a value planted by a cookie-injection primitive will not match.
//
// The output is base64url-encoded HMAC-SHA256 (43 characters).
func (i *TokenIssuer) CSRFToken(refreshPlain string) string {
	mac := hmac.New(sha256.New, i.key.Seed())
	mac.Write([]byte(csrfDerivationPrefix))
	mac.Write([]byte(refreshPlain))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// NewCSRFToken mints a random double submit token.
//
// Sessions no longer use this: their CSRF token is derived from the refresh token by
// TokenIssuer.CSRFToken so the pair is bound to one token (V-27). The helper is kept
// for callers and tests that need an unbound random value.
func NewCSRFToken() (string, error) { return randomToken(CSRFTokenBytes) }

func randomToken(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("auth: read random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// TokensEqual compares two secrets without leaking length or prefix through timing.
func TokensEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
