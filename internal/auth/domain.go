// Package auth holds authentication and session rules: how a caller proves who
// they are, how an access token is minted and verified, and how a refresh token
// lineage is rotated.
//
// Failures are sentinel errors. Mapping them onto HTTP status codes belongs to the
// transport layer, not here.
package auth

import (
	"errors"
	"time"

	"github.com/practacu/practacu-press/internal/site"
)

// Sentinel errors.
var (
	// ErrInvalidCredentials is returned for both an unknown account and a wrong
	// password on purpose: distinguishing them lets an attacker enumerate accounts.
	ErrInvalidCredentials = errors.New("auth: invalid credentials")
	// ErrEmailUnverified means the account exists but has not proven its address.
	ErrEmailUnverified = errors.New("auth: email unverified")
	// ErrAccountDisabled means the account is administratively disabled.
	ErrAccountDisabled = errors.New("auth: account disabled")
	// ErrSessionRevoked means the refresh token is no longer usable.
	ErrSessionRevoked = errors.New("auth: session revoked")
	// ErrRefreshReuse means an already rotated refresh token was presented. The
	// caller must revoke the whole token family.
	ErrRefreshReuse = errors.New("auth: refresh token reuse detected")
	// ErrCSRFMismatch means the double submit token did not match.
	ErrCSRFMismatch = errors.New("auth: csrf token mismatch")
	// ErrInvalidToken means the access token is malformed, mis-signed or forged.
	ErrInvalidToken = errors.New("auth: invalid access token")
	// ErrTokenExpired means the access token is well formed but past its expiry.
	ErrTokenExpired = errors.New("auth: access token expired")
	// ErrInvalidInput means a caller supplied value failed validation.
	ErrInvalidInput = errors.New("auth: invalid input")
	// ErrRegistrationClosed means the site has switched self-service registration off.
	ErrRegistrationClosed = errors.New("auth: registration closed")

	// ErrInvalidCode means the submitted phone verification code is wrong, expired or
	// already consumed. All three cases answer the same way on purpose: telling them
	// apart would let an attacker probe how close a guess was.
	ErrInvalidCode = errors.New("auth: invalid phone verification code")
	// ErrPhoneCodeNotFound means there is no redeemable phone code row. It is kept
	// apart from ErrInvalidCode so the persistence layer can report "nothing matched"
	// without deciding what the API should say.
	ErrPhoneCodeNotFound = errors.New("auth: phone verification code not found")
	// ErrSMSNotConfigured means the deployment has no SMS gateway, so phone login and
	// code delivery are unavailable. It maps to 503 sms_not_configured.
	ErrSMSNotConfigured = errors.New("auth: SMS gateway is not configured")

	// ErrPermissionToSite means the account is not a member of the target site.
	ErrPermissionToSite = errors.New("auth: not a member of this site")
	// ErrActionNotAllowed means the caller's role is too low for the action.
	ErrActionNotAllowed = errors.New("auth: action not allowed")
	// ErrTooManyAttempts means an account is temporarily locked after repeated failed
	// logins. The returned error also carries how long the caller must wait.
	ErrTooManyAttempts = errors.New("auth: too many failed login attempts")
	// ErrInstallRequiresLocalAccess means the install's first account (which becomes
	// the platform administrator) may only be created from a loopback host.
	ErrInstallRequiresLocalAccess = errors.New("auth: first administrator requires local access")
	// ErrCurrentPasswordInvalid means the authenticated caller did not prove the
	// current password when changing it.
	ErrCurrentPasswordInvalid = errors.New("auth: current password is invalid")
	// ErrPasswordUnchanged rejects a "change" that would set the same password.
	ErrPasswordUnchanged = errors.New("auth: new password must differ from the current one")
	// ErrAvatarInvalid means the referenced media asset is not a clean avatar owned
	// by the caller on the current site.
	ErrAvatarInvalid = errors.New("auth: avatar asset is invalid")
	// ErrEmailVerificationTokenInvalid covers unknown, expired and already redeemed
	// email verification tokens.
	ErrEmailVerificationTokenInvalid = errors.New("auth: email verification token is invalid or expired")

	// ErrTwoFactorAlreadyEnabled rejects a new enrollment while one is active; the
	// caller has to disable the current authenticator first so a stale secret cannot
	// be replaced silently.
	ErrTwoFactorAlreadyEnabled = errors.New("auth: two-factor authentication is already enabled")
	// ErrTwoFactorNotEnabled means the account has no active authenticator.
	ErrTwoFactorNotEnabled = errors.New("auth: two-factor authentication is not enabled")
	// ErrTwoFactorNotEnrolled means there is no pending enrollment to confirm.
	ErrTwoFactorNotEnrolled = errors.New("auth: no pending two-factor enrollment")
	// ErrInvalidTwoFactorCode covers a wrong TOTP code and an unknown or already
	// consumed recovery code: they are the same answer on purpose.
	ErrInvalidTwoFactorCode = errors.New("auth: two-factor code is invalid")
	// ErrTwoFactorReplayed means the submitted code belongs to a time step that has
	// already been accepted. One code is usable exactly once.
	ErrTwoFactorReplayed = errors.New("auth: two-factor code was already used")
	// ErrTwoFactorChallengeInvalid covers an expired, forged, already redeemed or
	// wrong-site challenge token.
	ErrTwoFactorChallengeInvalid = errors.New("auth: two-factor challenge is invalid or expired")
	// ErrTwoFactorUnavailable means the encryption envelope of a stored secret
	// cannot be opened, which normally means the signing key was rotated. The
	// account has to enroll again.
	ErrTwoFactorUnavailable = errors.New("auth: stored two-factor secret cannot be read")
	// ErrTwoFactorRequired is the sentinel matched by TwoFactorRequiredError.
	ErrTwoFactorRequired = errors.New("auth: two-factor verification required")
)

// TwoFactorRequiredError is the result of a password login for an account that has
// 2FA enabled: no session is issued, and the caller must prove the second factor
// with the short lived challenge token instead.
//
// It is an error so LoginPassword keeps its (Session, error) shape; the transport
// layer recognises it and answers 200 with the challenge body rather than a
// failure status.
type TwoFactorRequiredError struct {
	ChallengeToken string
	ExpiresAt      time.Time
}

// Error implements the error interface.
func (e *TwoFactorRequiredError) Error() string { return "auth: two-factor verification required" }

// Is makes errors.Is(err, ErrTwoFactorRequired) true for the typed marker.
func (e *TwoFactorRequiredError) Is(target error) bool { return target == ErrTwoFactorRequired }

// Account status values mirrored from the persistence schema.
const (
	// AccountStatusActive is the only status allowed to authenticate.
	AccountStatusActive = "active"
)

// Principal is an authenticated caller bound to one site.
type Principal struct {
	UserID string
	SiteID string
	Role   site.Role
}

// IsZero reports whether the principal was never populated.
func (p Principal) IsZero() bool { return p.UserID == "" }

// AtLeast reports whether the principal's role has at least the given authority.
func (p Principal) AtLeast(role site.Role) bool { return p.Role.AtLeast(role) }

// UserView is the user representation returned to clients.
type UserView struct {
	ID            string
	DisplayName   string
	Email         string
	EmailVerified bool
	Bio           string
	AvatarMediaID string
	Locale        string
	Status        string
	CreatedAt     time.Time
}

// ProfileInput is a partial self-service profile update.
//
// Nil means "leave unchanged", so an empty string pointer deliberately clears a
// field (empty bio, no avatar). DisplayName, when present, must be non-empty.
type ProfileInput struct {
	DisplayName   *string
	Bio           *string
	AvatarMediaID *string
}

// Session is the result of a successful registration, login or refresh.
//
// RefreshToken and CSRFToken are the plain values: they are returned to the client
// exactly once and only their hashes are persisted.
type Session struct {
	User             UserView
	AccessToken      string
	AccessExpiresAt  time.Time
	RefreshToken     string
	RefreshExpiresAt time.Time
	CSRFToken        string
}
