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

// Repository is the persistence contract for authentication.
//
// It is defined here, in the domain, so the service never depends on Ent.
type Repository interface {
	// CreateAccountWithEmail creates the account, its email identity and the site
	// membership in one transaction.
	CreateAccountWithEmail(ctx context.Context, in CreateAccountInput) (UserAccount, error)
	// FindEmailIdentity resolves a normalised email to its identity.
	FindEmailIdentity(ctx context.Context, email string) (Identity, error)
	// FindUser loads an account by id.
	FindUser(ctx context.Context, userID string) (UserAccount, error)
	// FindMembershipRole returns the current role of a user on a site.
	//
	// It is read on every session issue so a role change takes effect at the next
	// refresh instead of being frozen in a token minted days ago.
	FindMembershipRole(ctx context.Context, siteID, userID string) (site.Role, error)
	// CreateSession persists a new refresh session.
	CreateSession(ctx context.Context, record SessionRecord) error
	// FindSessionByHash loads a session by the hash of its refresh token.
	FindSessionByHash(ctx context.Context, tokenHash string) (SessionRecord, error)
	// RotateSession marks oldID as rotated and inserts next in one transaction.
	RotateSession(ctx context.Context, oldID string, rotatedAt time.Time, next SessionRecord) error
	// RevokeFamily revokes every live session in a family.
	RevokeFamily(ctx context.Context, familyID, reason string, at time.Time) error
	// RevokeSession revokes one session. Revoking an already revoked session is a
	// no-op, so logout is idempotent.
	RevokeSession(ctx context.Context, sessionID, reason string, at time.Time) error
}
