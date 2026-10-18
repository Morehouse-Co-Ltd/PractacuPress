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

	"github.com/practacu/practacu-press/apps/api/internal/site"
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
	ID          string
	DisplayName string
	Locale      string
	Status      string
	CreatedAt   time.Time
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
