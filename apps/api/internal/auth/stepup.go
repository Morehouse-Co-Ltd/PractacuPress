package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Step-up tokens.
//
// A high threat operation asks the caller to prove a password again. On success the
// server mints a short lived, stateless grant that the client echoes in the
// `X-PP-Step-Up` header of the operation it wanted to perform. The token is bound
// to one account and one site and signed with HMAC-SHA256, so:
//
//   - it cannot be used as an access token (different key derivation, different
//     shape, purpose free payload),
//   - a grant minted for an administrator on site A is worthless on site B,
//   - it dies within minutes even if it leaks.
//
// The HMAC key is derived from the issuer's Ed25519 seed, which means a deployment
// with a configured AUTH_JWT_ED25519_PRIVATE_KEY gets a stable key, and a
// development install without one gets the ephemeral key the issuer already made.
// No extra secret has to be configured.
const (
	// stepUpTokenVersion prefixes every token so a future format can be told apart.
	stepUpTokenVersion = "v1"
	// stepUpKeyDerivation separates the step-up HMAC key from the CSRF derivation and
	// from any other use of the signing seed as a MAC key.
	stepUpKeyDerivation = "practacu-press/step-up/v1"
)

// Step-up failures.
var (
	// ErrStepUpPasswordRejected means neither the site's dedicated security password
	// nor the caller's account login password matched. The API answers 403 with
	// reason `step_up_password_rejected`.
	ErrStepUpPasswordRejected = errors.New("auth: step-up password is invalid")
	// ErrStepUpUnavailable means the service was built without the token signer.
	ErrStepUpUnavailable = errors.New("auth: step-up verification is not configured")
)

// StepUpConfigReader reads the site's dedicated security password hash.
//
// It is a narrow port: the authentication service never sees the rest of the site
// configuration, and the site service never mints tokens. *site.Service implements
// it.
type StepUpConfigReader interface {
	// StepUpPasswordHash returns the stored Argon2id hash of the site's dedicated
	// security password, or "" when the site never set one.
	StepUpPasswordHash(ctx context.Context, siteID string) (string, error)
}

// stepUpClaims is the signed payload of one grant.
type stepUpClaims struct {
	UserID    string `json:"sub"`
	SiteID    string `json:"sid"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// StepUpSigner mints and verifies X-PP-Step-Up grants.
type StepUpSigner struct {
	key []byte
	ttl time.Duration
	now func() time.Time
}

// NewStepUpSigner derives the step-up signer from a token issuer.
//
// The derivation is one HMAC-SHA256 of a fixed label keyed by the issuer's Ed25519
// seed: the step-up key is never the seed itself, and rotating the signing key
// invalidates every outstanding grant too. ttl <= 0 falls back to
// site.StepUpTokenTTL.
func NewStepUpSigner(issuer *TokenIssuer, ttl time.Duration) *StepUpSigner {
	if issuer == nil {
		return nil
	}
	if ttl <= 0 {
		ttl = site.StepUpTokenTTL
	}
	mac := hmac.New(sha256.New, issuer.key.Seed())
	_, _ = mac.Write([]byte(stepUpKeyDerivation))
	now := issuer.now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &StepUpSigner{key: mac.Sum(nil), ttl: ttl, now: now}
}

// TTL returns how long a minted grant stays valid.
func (s *StepUpSigner) TTL() time.Duration {
	if s == nil {
		return 0
	}
	return s.ttl
}

// Issue mints a grant bound to one account and one site.
//
// The second return value is the lifetime in seconds, which the API returns to the
// client as `expires_in`.
func (s *StepUpSigner) Issue(userID, siteID string) (string, int, error) {
	if s == nil || len(s.key) == 0 {
		return "", 0, ErrStepUpUnavailable
	}
	if userID == "" || siteID == "" {
		return "", 0, fmt.Errorf("%w: user and site are required", ErrInvalidInput)
	}

	now := s.now()
	claims := stepUpClaims{
		UserID:    userID,
		SiteID:    siteID,
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(s.ttl).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", 0, fmt.Errorf("auth: encode step-up grant: %w", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	token := stepUpTokenVersion + "." + encoded + "." + s.mac(encoded)
	return token, int(s.ttl / time.Second), nil
}

// Verify reports whether raw is a valid grant for exactly this account and site.
//
// Every property is checked: format, signature (constant time), binding and
// expiry. A malformed, forged, foreign or expired token is simply false; the guard
// turns that into the documented 403, never into a different answer that would leak
// which check failed.
func (s *StepUpSigner) Verify(raw, userID, siteID string) bool {
	if s == nil || len(s.key) == 0 || raw == "" || userID == "" || siteID == "" {
		return false
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 || parts[0] != stepUpTokenVersion || parts[1] == "" || parts[2] == "" {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(s.mac(parts[1])), []byte(parts[2])) != 1 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims stepUpClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return false
	}
	if claims.UserID != userID || claims.SiteID != siteID {
		return false
	}
	if !s.now().Before(time.Unix(claims.ExpiresAt, 0)) {
		return false
	}
	return true
}

// mac computes the base64url HMAC of one encoded payload.
func (s *StepUpSigner) mac(encoded string) string {
	mac := hmac.New(sha256.New, s.key)
	_, _ = mac.Write([]byte(stepUpTokenVersion + "."))
	_, _ = mac.Write([]byte(encoded))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// VerifyStepUpPassword re-proves a password and mints a step-up grant.
//
// Order matters and is part of the contract: when the site has a dedicated security
// password and the submission matches it, that is enough; otherwise the caller's
// account login password is checked. A wrong password of either kind is reported as
// ErrStepUpPasswordRejected, so the client cannot learn which credential it nearly
// matched. Repeated failures are throttled by the existing credential limiter on
// the endpoint (and, for login passwords, by the shared account lockout).
func (s *Service) VerifyStepUpPassword(
	ctx context.Context,
	userID, siteID, password string,
) (string, int, error) {
	if userID == "" || siteID == "" {
		return "", 0, fmt.Errorf("%w: user and site are required", ErrInvalidInput)
	}
	if s.stepUpSigner == nil {
		return "", 0, ErrStepUpUnavailable
	}
	if password == "" {
		return "", 0, ErrStepUpPasswordRejected
	}

	if s.stepUpConfig != nil {
		hash, err := s.stepUpConfig.StepUpPasswordHash(ctx, siteID)
		if err != nil {
			return "", 0, err
		}
		if hash != "" {
			matches, verifyErr := s.hasher.Verify(ctx, password, hash)
			if verifyErr != nil {
				return "", 0, verifyErr
			}
			if matches {
				return s.issueStepUpGrant(ctx, userID, siteID, "site_password")
			}
		}
	}

	if err := s.verifyAccountPassword(ctx, userID, password); err != nil {
		switch {
		case errors.Is(err, ErrCurrentPasswordInvalid), errors.Is(err, ErrInvalidInput):
			return "", 0, ErrStepUpPasswordRejected
		default:
			return "", 0, err
		}
	}
	return s.issueStepUpGrant(ctx, userID, siteID, "account_password")
}

// issueStepUpGrant records the successful re-authentication and mints the token.
//
// Neither the password nor its hash is ever written: the audit entry names the
// method that succeeded.
func (s *Service) issueStepUpGrant(
	ctx context.Context,
	userID, siteID, method string,
) (string, int, error) {
	token, expiresIn, err := s.stepUpSigner.Issue(userID, siteID)
	if err != nil {
		return "", 0, err
	}
	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    userID,
		Action:     "auth.step_up.verified",
		TargetType: "user",
		TargetID:   userID,
		Detail:     map[string]any{"method": method},
	})
	return token, expiresIn, nil
}
