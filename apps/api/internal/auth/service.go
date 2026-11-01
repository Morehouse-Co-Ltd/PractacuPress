package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Service implements registration, login, refresh and logout.
type Service struct {
	repo                Repository
	hasher              PasswordHasher
	tokens              *TokenIssuer
	now                 func() time.Time
	refreshTTL          time.Duration
	requireVerification bool
	bootstrapFirstAdmin bool
	// mailer delivers password reset links. Nil means the deployment has no SMTP
	// relay, and the reset endpoints report themselves as unavailable.
	mailer mailer.Sender
	// publicBaseURL overrides the origin of reset links. Empty means the origin of
	// the request that asked for the reset is used.
	publicBaseURL string
	logger        *slog.Logger
}

// ServiceConfig configures a Service.
type ServiceConfig struct {
	// Repository is the persistence port.
	Repository Repository
	// Hasher performs password hashing. In production it is backed by the security
	// service; in development a local Argon2id implementation is acceptable.
	Hasher PasswordHasher
	// Tokens issues access tokens.
	Tokens *TokenIssuer
	// RequireEmailVerification refuses login until an email identity is verified.
	RequireEmailVerification bool
	// BootstrapFirstAdmin makes the first account of a site its platform
	// administrator. It exists for single site desktop installs, where nobody can
	// promote the first account afterwards; server deployments leave it off and
	// register plain members.
	BootstrapFirstAdmin bool
	// RefreshTTL defaults to RefreshTTL.
	RefreshTTL time.Duration
	// Now defaults to time.Now().UTC.
	Now func() time.Time
	// Mailer delivers transactional mail. Leaving it nil disables password reset,
	// which is the correct behaviour for an install without an SMTP relay.
	Mailer mailer.Sender
	// PublicBaseURL is the origin used in reset links, for example
	// "https://press.example.com". Empty falls back to the request origin.
	PublicBaseURL string
	// Logger records delivery failures. Nil discards them.
	Logger *slog.Logger
}

// NewService validates its dependencies and returns a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	switch {
	case cfg.Repository == nil:
		return nil, errors.New("auth: repository is required")
	case cfg.Hasher == nil:
		return nil, errors.New("auth: password hasher is required")
	case cfg.Tokens == nil:
		return nil, errors.New("auth: token issuer is required")
	}

	s := &Service{
		repo:                cfg.Repository,
		hasher:              cfg.Hasher,
		tokens:              cfg.Tokens,
		now:                 cfg.Now,
		refreshTTL:          cfg.RefreshTTL,
		requireVerification: cfg.RequireEmailVerification,
		bootstrapFirstAdmin: cfg.BootstrapFirstAdmin,
		mailer:              cfg.Mailer,
		publicBaseURL:       cfg.PublicBaseURL,
		logger:              cfg.Logger,
	}
	if s.refreshTTL <= 0 {
		s.refreshTTL = RefreshTTL
	}
	if s.now == nil {
		s.now = func() time.Time { return time.Now().UTC() }
	}
	return s, nil
}

// ClientMeta describes where a session was created. It is audit data only and must
// never be used for authorisation.
type ClientMeta struct {
	UserAgent string
	IPAddress string
}

// RegisterEmailInput is an email registration request.
type RegisterEmailInput struct {
	Email       string
	Password    string
	DisplayName string
	ClientMeta
}

// LoginInput is an email and password login request.
type LoginInput struct {
	Email    string
	Password string
	ClientMeta
}

// RegisterEmail creates an account on a site and starts a session.
//
// The password is hashed before the transaction opens: hashing is the expensive
// step and must not hold a database transaction open.
func (s *Service) RegisterEmail(ctx context.Context, siteID string, in RegisterEmailInput) (Session, error) {
	if siteID == "" {
		return Session{}, fmt.Errorf("%w: site is required", ErrInvalidInput)
	}

	email, err := NormalizeEmail(in.Email)
	if err != nil {
		return Session{}, err
	}
	if err := ValidatePassword(in.Password); err != nil {
		return Session{}, err
	}
	displayName, err := ValidateDisplayName(in.DisplayName)
	if err != nil {
		return Session{}, err
	}

	passwordHash, err := s.hasher.Hash(ctx, in.Password)
	if err != nil {
		return Session{}, err
	}

	role := string(site.RoleMember)
	if s.bootstrapFirstAdmin {
		// The count and the insert are not one transaction, so two simultaneous first
		// registrations could both win. A desktop install only ever has one operator,
		// and a server deployment never enables this rule.
		members, countErr := s.repo.CountSiteMembers(ctx, siteID)
		if countErr != nil {
			return Session{}, countErr
		}
		if members == 0 {
			role = string(site.RolePlatformAdmin)
		}
	}

	user, err := s.repo.CreateAccountWithEmail(ctx, CreateAccountInput{
		SiteID:       siteID,
		Email:        email,
		DisplayName:  displayName,
		PasswordHash: passwordHash,
		Verified:     !s.requireVerification,
		Role:         role,
	})
	if err != nil {
		return Session{}, err
	}

	session, record, err := s.buildSession(ctx, user, siteID, "", "", in.ClientMeta)
	if err != nil {
		return Session{}, err
	}
	if err := s.repo.CreateSession(ctx, record); err != nil {
		return Session{}, err
	}
	return session, nil
}

// CreateMemberInput is an administrator initiated account creation.
type CreateMemberInput struct {
	Email       string
	DisplayName string
	Password    string
	Role        site.Role
}

// CreateMember creates an account on a site without starting a session.
//
// This is the counterpart of self service registration for installs that keep
// registration closed (a personal blog, or a community with an invite only policy).
// The stored role is what the server enforces, so callers that want "every account is
// an administrator" must pass site_admin explicitly.
func (s *Service) CreateMember(
	ctx context.Context,
	actor Principal,
	siteID string,
	in CreateMemberInput,
) (UserView, error) {
	if siteID == "" {
		return UserView{}, fmt.Errorf("%w: site is required", ErrInvalidInput)
	}
	if actor.SiteID != siteID {
		return UserView{}, ErrPermissionToSite
	}
	if !actor.AtLeast(site.RoleSiteAdmin) {
		return UserView{}, ErrActionNotAllowed
	}

	role := in.Role
	if role == "" {
		role = site.RoleMember
	}
	if !role.Valid() {
		return UserView{}, fmt.Errorf("%w: unknown role", ErrInvalidInput)
	}
	if role == site.RolePlatformAdmin && actor.Role != site.RolePlatformAdmin {
		return UserView{}, ErrActionNotAllowed
	}

	email, err := NormalizeEmail(in.Email)
	if err != nil {
		return UserView{}, err
	}
	if err := ValidatePassword(in.Password); err != nil {
		return UserView{}, err
	}
	displayName, err := ValidateDisplayName(in.DisplayName)
	if err != nil {
		return UserView{}, err
	}

	passwordHash, err := s.hasher.Hash(ctx, in.Password)
	if err != nil {
		return UserView{}, err
	}

	user, err := s.repo.CreateAccountWithEmail(ctx, CreateAccountInput{
		SiteID:       siteID,
		Email:        email,
		DisplayName:  displayName,
		PasswordHash: passwordHash,
		Verified:     true,
		Role:         string(role),
	})
	if err != nil {
		return UserView{}, err
	}
	return user.View(), nil
}

// LoginPassword verifies an email and password and starts a session.
//
// An unknown account, a wrong password and a missing password credential all return
// ErrInvalidCredentials with identical shape, so the endpoint cannot be used to
// enumerate accounts.
func (s *Service) LoginPassword(ctx context.Context, siteID string, in LoginInput) (Session, error) {
	if siteID == "" {
		return Session{}, fmt.Errorf("%w: site is required", ErrInvalidInput)
	}

	email, err := NormalizeEmail(in.Email)
	if err != nil {
		return Session{}, ErrInvalidCredentials
	}
	if in.Password == "" {
		return Session{}, ErrInvalidCredentials
	}

	identity, err := s.repo.FindEmailIdentity(ctx, email)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return Session{}, ErrInvalidCredentials
		}
		return Session{}, err
	}

	if identity.PasswordHash == "" {
		return Session{}, ErrInvalidCredentials
	}

	if s.requireVerification && !identity.IsVerified() {
		return Session{}, ErrEmailUnverified
	}

	matches, err := s.hasher.Verify(ctx, in.Password, identity.PasswordHash)
	if err != nil {
		return Session{}, err
	}
	if !matches {
		return Session{}, ErrInvalidCredentials
	}

	user, err := s.repo.FindUser(ctx, identity.UserID)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return Session{}, ErrInvalidCredentials
		}
		return Session{}, err
	}
	if user.Status != AccountStatusActive {
		return Session{}, ErrAccountDisabled
	}

	session, record, err := s.buildSession(ctx, user, siteID, "", "", in.ClientMeta)
	if err != nil {
		return Session{}, err
	}
	if err := s.repo.CreateSession(ctx, record); err != nil {
		return Session{}, err
	}
	return session, nil
}

// Refresh rotates a refresh token and issues a new access token.
//
// Presenting an already rotated token means the token leaked: the whole lineage is
// revoked before the error is returned, so both the legitimate client and the
// attacker are logged out (design §7.3 rule 2).
func (s *Service) Refresh(ctx context.Context, siteID, refreshToken string) (Session, error) {
	if refreshToken == "" {
		return Session{}, ErrSessionRevoked
	}

	record, err := s.repo.FindSessionByHash(ctx, HashOpaqueToken(refreshToken))
	if err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			return Session{}, ErrSessionRevoked
		}
		return Session{}, err
	}

	now := s.now()

	if record.RotatedAt != nil {
		if revokeErr := s.repo.RevokeFamily(ctx, record.FamilyID, "refresh_reuse", now); revokeErr != nil {
			return Session{}, revokeErr
		}
		return Session{}, ErrRefreshReuse
	}

	if record.RevokedAt != nil || record.Expired(now) {
		return Session{}, ErrSessionRevoked
	}

	// A session lives on exactly one site. Refreshing on another site would mint a
	// token carrying this site's role for a different site's resources.
	if record.SiteID != siteID {
		return Session{}, ErrSessionRevoked
	}

	user, err := s.repo.FindUser(ctx, record.UserID)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return Session{}, ErrSessionRevoked
		}
		return Session{}, err
	}
	if user.Status != AccountStatusActive {
		return Session{}, ErrAccountDisabled
	}

	session, next, err := s.buildSession(ctx, user, siteID, record.FamilyID, record.ID, ClientMeta{
		UserAgent: record.UserAgent,
		IPAddress: record.IPAddress,
	})
	if err != nil {
		return Session{}, err
	}

	if err := s.repo.RotateSession(ctx, record.ID, now, next); err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			// Another request won the race and already rotated this token.
			return Session{}, ErrSessionRevoked
		}
		return Session{}, err
	}

	return session, nil
}

// Logout revokes the session behind a refresh token.
//
// An unknown or already revoked token is not an error: logout must be safe to retry.
func (s *Service) Logout(ctx context.Context, refreshToken string) error {
	if refreshToken == "" {
		return nil
	}

	record, err := s.repo.FindSessionByHash(ctx, HashOpaqueToken(refreshToken))
	if err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			return nil
		}
		return err
	}

	return s.repo.RevokeSession(ctx, record.ID, "logout", s.now())
}

// Me returns the account behind an authenticated principal.
func (s *Service) Me(ctx context.Context, userID string) (UserView, error) {
	user, err := s.repo.FindUser(ctx, userID)
	if err != nil {
		return UserView{}, err
	}
	return user.View(), nil
}

// buildSession mints the token material for a session but does not persist it, so
// the caller can join the write to an existing transaction.
func (s *Service) buildSession(
	ctx context.Context,
	user UserAccount,
	siteID, familyID, parentID string,
	meta ClientMeta,
) (Session, SessionRecord, error) {
	role, err := s.repo.FindMembershipRole(ctx, siteID, user.ID)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return Session{}, SessionRecord{}, ErrPermissionToSite
		}
		return Session{}, SessionRecord{}, err
	}

	refresh, err := NewRefreshToken()
	if err != nil {
		return Session{}, SessionRecord{}, err
	}

	csrf, err := NewCSRFToken()
	if err != nil {
		return Session{}, SessionRecord{}, err
	}

	accessToken, accessExpiry, err := s.tokens.IssueAccess(Principal{
		UserID: user.ID,
		SiteID: siteID,
		Role:   role,
	})
	if err != nil {
		return Session{}, SessionRecord{}, err
	}

	if familyID == "" {
		familyID = uuid.Must(uuid.NewV7()).String()
	}

	now := s.now()
	record := SessionRecord{
		ID:        uuid.Must(uuid.NewV7()).String(),
		UserID:    user.ID,
		SiteID:    siteID,
		TokenHash: refresh.Hash,
		FamilyID:  familyID,
		ParentID:  parentID,
		UserAgent: truncate(meta.UserAgent, 512),
		IPAddress: truncate(meta.IPAddress, 64),
		ExpiresAt: now.Add(s.refreshTTL),
	}

	return Session{
		User:             user.View(),
		AccessToken:      accessToken,
		AccessExpiresAt:  accessExpiry,
		RefreshToken:     refresh.Plain,
		RefreshExpiresAt: record.ExpiresAt,
		CSRFToken:        csrf,
	}, record, nil
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
