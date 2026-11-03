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
	familyAbsoluteTTL   time.Duration
	requireVerification bool
	bootstrapFirstAdmin bool
	// loginFailures is the account scoped half of the brute force defence. It is
	// in-process (see loginThrottle) and layered on top of the IP scoped limiter the
	// transport layer charges.
	loginFailures *loginThrottle
	// mailer delivers password reset links. Nil means the deployment has no SMTP
	// relay, and the reset endpoints report themselves as unavailable.
	// registrationPolicy answers whether anonymous accounts may be created on a
	// site. Nil means "open" (legacy behaviour); the server wires it to the site
	// setting so an operator can close sign-ups without a redeploy.
	registrationPolicy func(ctx context.Context, siteID string) (bool, error)
	mailer             mailer.Sender
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
	// RefreshFamilyAbsoluteTTL caps the lifetime of one refresh lineage in total,
	// regardless of rotation. Defaults to RefreshFamilyAbsoluteTTL (90 days).
	RefreshFamilyAbsoluteTTL time.Duration
	// Now defaults to time.Now().UTC.
	Now func() time.Time
	// RegistrationPolicy, when set, is consulted before a self-service account is
	// created. A false answer is reported as ErrRegistrationClosed.
	RegistrationPolicy func(ctx context.Context, siteID string) (bool, error)
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
		familyAbsoluteTTL:   cfg.RefreshFamilyAbsoluteTTL,
		requireVerification: cfg.RequireEmailVerification,
		bootstrapFirstAdmin: cfg.BootstrapFirstAdmin,
		registrationPolicy:  cfg.RegistrationPolicy,
		mailer:              cfg.Mailer,
		publicBaseURL:       cfg.PublicBaseURL,
		logger:              cfg.Logger,
	}
	if s.refreshTTL <= 0 {
		s.refreshTTL = RefreshTTL
	}
	if s.familyAbsoluteTTL <= 0 {
		s.familyAbsoluteTTL = RefreshFamilyAbsoluteTTL
	}
	if s.now == nil {
		s.now = func() time.Time { return time.Now().UTC() }
	}
	s.loginFailures = newLoginThrottle(s.now)
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
	// AllowFirstAdmin reports whether this request is allowed to claim the install's
	// first account when BootstrapFirstAdmin is on. The handler sets it from the
	// request host: only a loopback caller may become the first platform administrator
	// (an exposed, not yet installed instance must not be claimable over the network).
	AllowFirstAdmin bool
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

	if s.registrationPolicy != nil {
		open, policyErr := s.registrationPolicy(ctx, siteID)
		if policyErr != nil {
			return Session{}, policyErr
		}
		if !open {
			return Session{}, ErrRegistrationClosed
		}
	}

	role := string(site.RoleMember)
	if s.bootstrapFirstAdmin {
		// The count and the insert are not one transaction, so two simultaneous first
		// registrations could both win. A desktop install only ever has one operator,
		// and a server deployment never enables this rule.
		//
		// Only a loopback caller may claim the first account: an install that is
		// already exposed before its owner registers would otherwise be taken over by
		// whoever reaches it first (V-16). The check happens before hashing so a remote
		// caller cannot spend the Argon2 budget on a request that will be refused.
		members, countErr := s.repo.CountSiteMembers(ctx, siteID)
		if countErr != nil {
			return Session{}, countErr
		}
		if members == 0 {
			if !in.AllowFirstAdmin {
				return Session{}, ErrInstallRequiresLocalAccess
			}
			role = string(site.RolePlatformAdmin)
		}
	}

	passwordHash, err := s.hasher.Hash(ctx, in.Password)
	if err != nil {
		return Session{}, err
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

	session, record, err := s.buildSession(ctx, user, siteID, "", "", in.ClientMeta, time.Time{})
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
// An unknown account, a wrong password and a disabled account all return
// ErrInvalidCredentials with identical shape and, crucially, identical cost: when no
// account (or no password credential) matches, the submitted password is still run
// through a dummy verification against a fixed PHC string, so the response time does
// not reveal whether the address is registered.
//
// Repeated failures for one address are counted in-process and the account is
// temporarily locked with exponential backoff (see loginThrottle). The transport
// layer's credential rate limiter stays as the independent IP scoped half.
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

	if retryAfter, locked := s.loginFailures.blocked(email); locked {
		return Session{}, &TooManyAttemptsError{RetryAfter: retryAfter}
	}

	identity, err := s.repo.FindEmailIdentity(ctx, email)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			// Spend the same hashing work as an existing account would. A failure of
			// the hasher is propagated, not swallowed: otherwise an unknown address
			// would answer 401 while a known one answers 5xx when the security service
			// is down, which is itself an existence oracle.
			if _, verifyErr := s.hasher.Verify(ctx, in.Password, dummyPasswordHash); verifyErr != nil {
				return Session{}, verifyErr
			}
			// Count the failure as if the account existed. The lockout must not become
			// a faster enumeration oracle than the timing it replaced: "5x 401 then
			// 429" has to look identical for registered and unknown addresses.
			s.loginFailures.failure(email)
			return Session{}, ErrInvalidCredentials
		}
		return Session{}, err
	}

	if identity.PasswordHash == "" {
		// A provider-only identity has no password to compare. Do the same dummy work
		// so "this address exists but is OAuth-only" is not a timing signal either.
		if _, verifyErr := s.hasher.Verify(ctx, in.Password, dummyPasswordHash); verifyErr != nil {
			return Session{}, verifyErr
		}
		s.loginFailures.failure(email)
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
		s.loginFailures.failure(email)
		return Session{}, ErrInvalidCredentials
	}

	user, err := s.repo.FindUser(ctx, identity.UserID)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			s.loginFailures.failure(email)
			return Session{}, ErrInvalidCredentials
		}
		return Session{}, err
	}
	if user.Status != AccountStatusActive {
		// The password was correct, so this is not a guessing attempt: clear the streak
		// instead of locking the owner out. The response is byte for byte the same as a
		// wrong password: a distinct "account disabled" code would be an enumeration
		// channel (a refresh of an existing session may still surface the disabled
		// state, because there the caller already proved possession of a token).
		s.loginFailures.success(email)
		return Session{}, ErrInvalidCredentials
	}

	session, record, err := s.buildSession(ctx, user, siteID, "", "", in.ClientMeta, time.Time{})
	if err != nil {
		return Session{}, err
	}
	if err := s.repo.CreateSession(ctx, record); err != nil {
		return Session{}, err
	}

	s.loginFailures.success(email)
	return session, nil
}

// Refresh rotates a refresh token and issues a new access token.
//
// Presenting an already rotated token means the token leaked: the whole lineage is
// revoked before the error is returned, so both the legitimate client and the
// attacker are logged out (design §7.3 rule 2). The same applies to a lost rotation
// race: another request rotated this token between our read and our conditional
// update, which is indistinguishable from a replay, so the family is revoked too.
//
// Rotation inherits the lineage's birth time: a family has an absolute lifetime
// (RefreshFamilyAbsoluteTTL) that no amount of refreshing can extend. Past it the
// family is revoked instead of rotated.
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
		if revokeErr := s.revokeFamily(ctx, record.FamilyID, "refresh_reuse", now); revokeErr != nil {
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

	// The lineage's hard ceiling: rotation must inherit the birth time, never reset it.
	familyCreatedAt, err := s.repo.FamilyCreatedAt(ctx, record.FamilyID)
	if err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			return Session{}, ErrSessionRevoked
		}
		return Session{}, err
	}
	familyExpiresAt := familyCreatedAt.Add(s.familyAbsoluteTTL)
	if !now.Before(familyExpiresAt) {
		if revokeErr := s.revokeFamily(ctx, record.FamilyID, "refresh_family_expired", now); revokeErr != nil {
			return Session{}, revokeErr
		}
		return Session{}, ErrSessionRevoked
	}

	session, next, err := s.buildSession(ctx, user, siteID, record.FamilyID, record.ID, ClientMeta{
		UserAgent: record.UserAgent,
		IPAddress: record.IPAddress,
	}, familyExpiresAt)
	if err != nil {
		return Session{}, err
	}

	if err := s.repo.RotateSession(ctx, record.ID, now, next); err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			// Lost the compare and swap: another request rotated the same token between
			// our read and this update. That is exactly the concurrent reuse case: the
			// loser must not leave the winner's session alive, so the family dies.
			if revokeErr := s.revokeFamily(ctx, record.FamilyID, "refresh_reuse", s.now()); revokeErr != nil {
				return Session{}, revokeErr
			}
			s.logInfo("refresh token reuse detected on concurrent rotation",
				"user_id", record.UserID)
			return Session{}, ErrRefreshReuse
		}
		return Session{}, err
	}

	return session, nil
}

// revokeFamily burns a refresh token lineage and records why.
func (s *Service) revokeFamily(ctx context.Context, familyID, reason string, at time.Time) error {
	if err := s.repo.RevokeFamily(ctx, familyID, reason, at); err != nil {
		return err
	}
	s.logInfo("refresh token family revoked", "reason", reason)
	return nil
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

// CSRFToken returns the double submit token bound to one refresh token.
//
// The transport layer recomputes it from the refresh cookie before accepting a
// refresh or logout, so a cookie/header pair that is merely self-consistent still
// fails (it was not derived from that token).
func (s *Service) CSRFToken(refreshPlain string) string {
	return s.tokens.CSRFToken(refreshPlain)
}

// buildSession mints the token material for a session but does not persist it, so
// the caller can join the write to an existing transaction.
//
// expiresNotAfter, when set, is a hard ceiling for the refresh expiry (the lineage's
// absolute deadline); the idle lifetime is capped by it so neither the stored row nor
// the cookie can outlive the lineage.
func (s *Service) buildSession(
	ctx context.Context,
	user UserAccount,
	siteID, familyID, parentID string,
	meta ClientMeta,
	expiresNotAfter time.Time,
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

	// The double submit token is not independent random material: it is derived from
	// the refresh token, so a pair is only valid together with the exact token it was
	// issued for (V-27). Rotation therefore changes the CSRF token automatically.
	csrf := s.tokens.CSRFToken(refresh.Plain)

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
	expiresAt := now.Add(s.refreshTTL)
	if !expiresNotAfter.IsZero() && expiresAt.After(expiresNotAfter) {
		expiresAt = expiresNotAfter
	}
	record := SessionRecord{
		ID:        uuid.Must(uuid.NewV7()).String(),
		UserID:    user.ID,
		SiteID:    siteID,
		TokenHash: refresh.Hash,
		FamilyID:  familyID,
		ParentID:  parentID,
		UserAgent: truncate(meta.UserAgent, 512),
		IPAddress: truncate(meta.IPAddress, 64),
		ExpiresAt: expiresAt,
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
