package auth

import (
	"context"
	"errors"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Sentinel errors produced by the persistence layer.
var (
	// ErrIdentityExists means the email, phone or provider subject is already bound.
	ErrIdentityExists = errors.New("auth: identity already exists")
	// ErrAccountNotFound means no account or identity matched.
	ErrAccountNotFound = errors.New("auth: account not found")
	// ErrSessionNotFound means no session matched the refresh token hash.
	ErrSessionNotFound = errors.New("auth: session not found")
	// ErrSiteMissing means the target site does not exist.
	ErrSiteMissing = errors.New("auth: site missing")
	// ErrVerificationTokenNotFound means no token matched the hash.
	ErrVerificationTokenNotFound = errors.New("auth: verification token not found")
)

// UserAccount is the account fields authentication needs.
type UserAccount struct {
	ID          string
	DisplayName string
	Status      string
	Locale      string
	CreatedAt   time.Time
}

// View converts an account to its client representation.
func (u UserAccount) View() UserView {
	return UserView{
		ID:          u.ID,
		DisplayName: u.DisplayName,
		Locale:      u.Locale,
		Status:      u.Status,
		CreatedAt:   u.CreatedAt,
	}
}

// Identity is a login method bound to one account.
type Identity struct {
	ID           string
	UserID       string
	Provider     string
	Subject      string
	Email        string
	PasswordHash string
	VerifiedAt   *time.Time
}

// IsVerified reports whether the identity has proven ownership.
func (i Identity) IsVerified() bool { return i.VerifiedAt != nil }

// SessionRecord is one persisted refresh token lineage entry.
type SessionRecord struct {
	ID        string
	UserID    string
	SiteID    string
	TokenHash string
	FamilyID  string
	ParentID  string
	UserAgent string
	IPAddress string
	ExpiresAt time.Time
	RotatedAt *time.Time
	RevokedAt *time.Time
}

// Expired reports whether the record is past its absolute lifetime.
func (s SessionRecord) Expired(now time.Time) bool { return !now.Before(s.ExpiresAt) }

// Reusable reports whether the record may still be exchanged for a new session.
func (s SessionRecord) Reusable(now time.Time) bool {
	return s.RevokedAt == nil && s.RotatedAt == nil && !s.Expired(now)
}

// CreateAccountInput is everything needed to register an email account.
type CreateAccountInput struct {
	SiteID       string
	Email        string
	DisplayName  string
	PasswordHash string
	Verified     bool
	Role         string
}

// VerificationToken is a single use credential for an email mediated action.
//
// Only the hash is stored, so a database leak cannot be replayed against the API.
type VerificationToken struct {
	ID         string
	UserID     string
	Kind       string
	TokenHash  string
	ExpiresAt  time.Time
	CreatedAt  time.Time
	ConsumedAt *time.Time
}

// Live reports whether the token may still be redeemed at now.
func (t VerificationToken) Live(now time.Time) bool {
	return t.ConsumedAt == nil && now.Before(t.ExpiresAt)
}

// Repository is the persistence contract for authentication.
//
// It is defined here, in the domain, so the service never depends on Ent.
type Repository interface {
	// CreateAccountWithEmail creates the account, its email identity and the site
	// membership in one transaction.
	CreateAccountWithEmail(ctx context.Context, in CreateAccountInput) (UserAccount, error)
	// FindEmailIdentity resolves a normalised email to its identity.
	FindEmailIdentity(ctx context.Context, email string) (Identity, error)
	// FindEmailIdentityByUser resolves the email identity of one account.
	FindEmailIdentityByUser(ctx context.Context, userID string) (Identity, error)
	// FindUser loads an account by id.
	FindUser(ctx context.Context, userID string) (UserAccount, error)
	// UpdatePasswordHash replaces the stored hash. A non nil verifiedAt also marks
	// the address as proven, but only when it was not proven before: a password
	// reset must not be able to unverify anything.
	UpdatePasswordHash(ctx context.Context, identityID, passwordHash string, verifiedAt *time.Time) error
	// FindMembershipRole returns the current role of a user on a site.
	//
	// It is read on every session issue so a role change takes effect at the next
	// refresh instead of being frozen in a token minted days ago.
	FindMembershipRole(ctx context.Context, siteID, userID string) (site.Role, error)
	// CountSiteMembers returns how many accounts belong to a site.
	//
	// The desktop bootstrap uses it to hand the first account of a fresh install the
	// administrator role; every other deployment registers plain members.
	CountSiteMembers(ctx context.Context, siteID string) (int, error)
	// CreateSession persists a new refresh session.
	CreateSession(ctx context.Context, record SessionRecord) error
	// FindSessionByHash loads a session by the hash of its refresh token.
	FindSessionByHash(ctx context.Context, tokenHash string) (SessionRecord, error)
	// RotateSession marks oldID as rotated and inserts next in one transaction.
	RotateSession(ctx context.Context, oldID string, rotatedAt time.Time, next SessionRecord) error
	// FamilyCreatedAt returns when a refresh token lineage first came into being: the
	// created_at of its oldest session row. Rotation never rewrites it, which is what
	// makes a hard absolute lifetime on the lineage enforceable.
	FamilyCreatedAt(ctx context.Context, familyID string) (time.Time, error)
	// RevokeFamily revokes every live session in a family.
	RevokeFamily(ctx context.Context, familyID, reason string, at time.Time) error
	// RevokeSession revokes one session. Revoking an already revoked session is a
	// no-op, so logout is idempotent.
	RevokeSession(ctx context.Context, sessionID, reason string, at time.Time) error
	// RevokeUserSessions revokes every live session of one account. A password
	// change has to invalidate what an attacker may already hold.
	RevokeUserSessions(ctx context.Context, userID, reason string, at time.Time) error

	// CreateVerificationToken stores a new single use token.
	CreateVerificationToken(ctx context.Context, token VerificationToken) error
	// FindVerificationToken resolves the hash of a token.
	FindVerificationToken(ctx context.Context, tokenHash string) (VerificationToken, error)
	// LatestLiveVerificationToken returns the newest unredeemed, unexpired token of
	// a kind, or ErrVerificationTokenNotFound. It backs the request cooldown.
	LatestLiveVerificationToken(ctx context.Context, userID, kind string, now time.Time) (VerificationToken, error)
	// ConsumeVerificationToken marks a token redeemed. It reports false when the row
	// was already redeemed by a concurrent request, which is what makes redemption
	// single use under a race.
	ConsumeVerificationToken(ctx context.Context, id string, at time.Time) (bool, error)
	// InvalidateVerificationTokens retires every live token of a kind, so a new
	// request does not leave older links working.
	InvalidateVerificationTokens(ctx context.Context, userID, kind string, at time.Time) error
}
