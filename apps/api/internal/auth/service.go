package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
	"github.com/practacu/practacu-press/apps/api/internal/platform/sms"
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
	// mailLog records reset and verification mail in the shared email_logs table, so
	// the dashboard's mail log covers system mail too. Nil means "do not record":
	// delivery is unaffected and behaves exactly as it did before the log existed.
	mailLog MailLog
	// publicBaseURL overrides the origin of reset links. Empty means the origin of
	// the request that asked for the reset is used.
	publicBaseURL string
	// audit records security relevant account events. Nil disables recording; the
	// change itself still succeeds, because an audit outage must not lock users out.
	audit audit.Recorder
	// avatars validates a referenced media asset before it becomes a profile image.
	// Nil rejects every non-empty avatar id (the safe default for tests that do not
	// model the media module).
	avatars AvatarValidator
	// secrets seals the TOTP shared secrets at rest. It is derived from the token
	// issuer's signing seed, so it never has to be configured separately.
	secrets *secretBox
	// stepUpSigner mints the short lived grants high threat operations require.
	// Nil means the feature is not wired; the verify endpoint then fails closed.
	stepUpSigner *StepUpSigner
	// stepUpConfig reads the site's optional dedicated security password. Nil means
	// only account login passwords can authorize a step-up.
	stepUpConfig StepUpConfigReader
	// phone is the persistence port of phone code login. Nil disables the feature:
	// the policy endpoint reports it as not enabled and the endpoints answer
	// sms_not_configured instead of writing codes nobody can redeem.
	phone PhoneRepository
	// sms delivers verification codes. Nil means no gateway is wired.
	sms sms.Sender
	// smsProvider is the provider name reported by GET /auth/phone/policy.
	smsProvider string
	// smsDevMode returns the code in the request response and fixes it to DevPhoneCode.
	smsDevMode bool
	// smsCodeTTL is how long a requested code stays valid.
	smsCodeTTL time.Duration
	logger     *slog.Logger
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
	// MailLog records every system mail attempt in the shared email log
	// (email_logs). Leaving it nil keeps the old behaviour: mail is delivered but
	// nothing is recorded, because a logging port is an observability add on and
	// never a delivery precondition.
	MailLog MailLog
	// PublicBaseURL is the origin used in reset links, for example
	// "https://press.example.com". Empty falls back to the request origin.
	PublicBaseURL string
	// Audit records account security events. Nil records nothing.
	Audit audit.Recorder
	// AvatarValidator checks an avatar media reference. Nil means no avatar may be
	// set, which keeps a service wired without the media module honest.
	AvatarValidator AvatarValidator
	// StepUpSigner mints the grants a high threat operation requires. Nil disables
	// the step-up verification endpoint (it answers an internal error rather than
	// handing out a grant it cannot verify).
	StepUpSigner *StepUpSigner
	// StepUpConfig reads each site's dedicated security password. Nil means only the
	// caller's account login password can authorize a step-up.
	StepUpConfig StepUpConfigReader
	// PhoneCodes is the persistence port of phone code login (contract A).
	//
	// Leaving it nil falls back to Repository when that also implements
	// PhoneRepository: the server wires one authstore for both, and typing it twice
	// is exactly the kind of wiring mistake that silently disables a feature. Phone
	// login still stays off unless SMS is configured too.
	PhoneCodes PhoneRepository
	// SMS delivers phone verification codes. Nil disables phone login.
	SMS sms.Sender
	// SMSProvider is the gateway name the policy endpoint reports ("off", "log" or
	// "http"). Empty is derived from SMS: a configured sender means the log provider
	// was wired by hand.
	SMSProvider string
	// SMSDevMode returns the verification code in the request response. config.Load
	// refuses it in production; a hand built Service is trusted to have decided.
	SMSDevMode bool
	// SMSCodeTTL defaults to DefaultPhoneCodeTTL (5 minutes).
	SMSCodeTTL time.Duration
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
		mailLog:             cfg.MailLog,
		publicBaseURL:       cfg.PublicBaseURL,
		audit:               cfg.Audit,
		avatars:             cfg.AvatarValidator,
		stepUpSigner:        cfg.StepUpSigner,
		stepUpConfig:        cfg.StepUpConfig,
		phone:               phoneRepository(cfg),
		sms:                 cfg.SMS,
		smsProvider:         normalizeSMSProvider(cfg.SMSProvider, cfg.SMS),
		smsDevMode:          cfg.SMSDevMode,
		smsCodeTTL:          cfg.SMSCodeTTL,
		logger:              cfg.Logger,
	}
	if s.smsCodeTTL <= 0 {
		s.smsCodeTTL = DefaultPhoneCodeTTL
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
	secrets, err := cfg.Tokens.secretBox()
	if err != nil {
		return nil, err
	}
	s.secrets = secrets
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
	// BaseURL is the browser origin used in the verification link. Empty falls back
	// to PublicBaseURL; if both are empty the link is relative.
	BaseURL string
	ClientMeta
}

// LoginInput is a password login request.
//
// Identifier is the account email or the account display name; Email is kept for
// clients built against the older contract (it is only read when Identifier is empty).
type LoginInput struct {
	Identifier string
	Email      string
	Password   string
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
		// An install without SMTP cannot prove an address, so it keeps the legacy
		// behaviour and treats the account as verified. When mail works, the account
		// starts unverified and a verification link is sent; login is still allowed
		// (soft verification), because locking every new account out of a working
		// deployment until it clicks a mail would be a worse failure mode.
		Verified: !s.mailReady(),
		Role:     role,
	})
	if err != nil {
		return Session{}, err
	}

	if s.mailReady() && user.EmailVerifiedAt == nil {
		if _, sendErr := s.sendEmailVerification(ctx, user.ID, siteID, email, in.BaseURL); sendErr != nil {
			// A delivery failure must not fail registration: the account exists and the
			// owner can ask for another link from the profile page.
			s.logError("registration verification mail failed", "error", sendErr, "user_id", user.ID)
		}
	}

	session, record, err := s.buildSession(ctx, user, siteID, "", "", in.ClientMeta, time.Time{})
	if err != nil {
		return Session{}, err
	}
	if err := s.repo.CreateSession(ctx, record); err != nil {
		return Session{}, err
	}
	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    user.ID,
		Action:     "auth.registered",
		TargetType: "user",
		TargetID:   user.ID,
		Detail:     map[string]any{"email_verified": user.EmailVerifiedAt != nil},
	})
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
	// New accounts can never be minted as platform administrators: the deployment
	// owner role is granted only by an existing platform administrator through an
	// explicit role change, never as a side effect of creating a member.
	if role == site.RolePlatformAdmin {
		return UserView{}, ErrActionNotAllowed
	}

	return s.createAccount(ctx, siteID, in, role)
}

// ProvisionSiteOwner creates the first administrator account of a site that was just
// created by the platform console.
//
// It performs no actor check by design: the platform service has already verified that
// the caller is a deployment level administrator, and there is no membership on the new
// site yet to authorize against. The account is always a site administrator (the owner
// of that site), never a platform administrator, so creating a site cannot mint another
// deployment owner.
func (s *Service) ProvisionSiteOwner(
	ctx context.Context,
	siteID string,
	in CreateMemberInput,
) (UserView, error) {
	if siteID == "" {
		return UserView{}, fmt.Errorf("%w: site is required", ErrInvalidInput)
	}
	return s.createAccount(ctx, siteID, in, site.RoleSiteAdmin)
}

// createAccount validates the input, hashes the password and creates the account with
// its membership. The role has already been authorised by the caller.
func (s *Service) createAccount(
	ctx context.Context,
	siteID string,
	in CreateMemberInput,
	role site.Role,
) (UserView, error) {
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

// maxLoginIdentifierBytes bounds the submitted identifier before any lookup. An
// identifier is an email or a display name (at most 120 runes), so 512 bytes is
// generous and still rejects absurd payloads before they reach the database.
const maxLoginIdentifierBytes = 512

// LoginPassword verifies an email or username plus password and starts a session.
//
// The identifier may be the account email or the account display name. Display names
// are not unique; when two accounts share one, that identifier cannot log in (the
// caller has to use an email) and the answer stays the generic credentials error.
//
// An unknown account, a wrong password and a disabled account all return
// ErrInvalidCredentials with identical shape and, crucially, identical cost: when no
// account (or no password credential) matches, the submitted password is still run
// through a dummy verification against a fixed PHC string, so the response time does
// not reveal whether the identifier is registered.
//
// Repeated failures for one account are counted in-process and the account is
// temporarily locked with exponential backoff (see loginThrottle). Username and email
// attempts resolve to the same account key, so they share one streak. The transport
// layer's credential rate limiter stays as the independent IP scoped half.
func (s *Service) LoginPassword(ctx context.Context, siteID string, in LoginInput) (Session, error) {
	if siteID == "" {
		return Session{}, fmt.Errorf("%w: site is required", ErrInvalidInput)
	}
	if in.Password == "" {
		return Session{}, ErrInvalidCredentials
	}

	identifier := strings.TrimSpace(in.Identifier)
	if identifier == "" {
		// Backward compatible: older clients only sent `email`.
		identifier = strings.TrimSpace(in.Email)
	}
	throttleKey := normalizeLoginKey(identifier)
	if identifier == "" || len(identifier) > maxLoginIdentifierBytes {
		return Session{}, s.rejectUnknownIdentifier(ctx, in.Password, throttleKey)
	}

	identity, err := s.resolveLoginIdentity(ctx, identifier)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return Session{}, s.rejectUnknownIdentifier(ctx, in.Password, throttleKey)
		}
		return Session{}, err
	}
	// A resolved identity is always bound to a normalised email; counting failures
	// against it keeps a username attempt and an email attempt in one lockout streak.
	throttleKey = normalizeLoginKey(identity.Email)

	if identity.PasswordHash == "" {
		// A provider-only identity has no password to compare. Do the same dummy work
		// so "this address exists but is OAuth-only" is not a timing signal either.
		if _, verifyErr := s.hasher.Verify(ctx, in.Password, dummyPasswordHash); verifyErr != nil {
			return Session{}, verifyErr
		}
		return Session{}, s.invalidLogin(throttleKey)
	}

	if s.requireVerification && !identity.IsVerified() {
		return Session{}, ErrEmailUnverified
	}

	matches, err := s.hasher.Verify(ctx, in.Password, identity.PasswordHash)
	if err != nil {
		return Session{}, err
	}
	if !matches {
		return Session{}, s.invalidLogin(throttleKey)
	}

	user, err := s.repo.FindUser(ctx, identity.UserID)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return Session{}, s.invalidLogin(throttleKey)
		}
		return Session{}, err
	}
	if user.Status != AccountStatusActive {
		// The password was correct, so this is not a guessing attempt: clear the streak
		// instead of locking the owner out. The response is byte for byte the same as a
		// wrong password: a distinct "account disabled" code would be an enumeration
		// channel (a refresh of an existing session may still surface the disabled
		// state, because there the caller already proved possession of a token).
		s.loginFailures.success(throttleKey)
		return Session{}, ErrInvalidCredentials
	}

	// FSD F-04: an account with an active authenticator does not get a session from
	// the password alone. The password was correct, so the failure streak is cleared
	// first; the challenge is a success of the first factor, not a failed attempt.
	if err := s.startTwoFactorChallenge(ctx, user, siteID); err != nil {
		s.loginFailures.success(throttleKey)
		return Session{}, err
	}

	session, record, err := s.buildSession(ctx, user, siteID, "", "", in.ClientMeta, time.Time{})
	if err != nil {
		return Session{}, err
	}
	if err := s.repo.CreateSession(ctx, record); err != nil {
		return Session{}, err
	}

	s.loginFailures.success(throttleKey)
	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    user.ID,
		Action:     "auth.login",
		TargetType: "user",
		TargetID:   user.ID,
	})
	return session, nil
}

// rejectUnknownIdentifier spends one dummy verification and records the failure.
//
// It is the single path for "no usable identity": an unknown email, an unknown
// username, an ambiguous display name or a malformed identifier. The hasher error is
// propagated, not swallowed: otherwise an unknown identifier would answer 401 while a
// known one answers 5xx when the security service is down, which is itself an
// existence oracle.
func (s *Service) rejectUnknownIdentifier(
	ctx context.Context,
	password string,
	throttleKey string,
) error {
	if _, verifyErr := s.hasher.Verify(ctx, password, dummyPasswordHash); verifyErr != nil {
		return verifyErr
	}
	// Count the failure as if the account existed. The lockout must not become a
	// faster enumeration oracle than the timing it replaced: "5x 401 then 429" has to
	// look identical for registered and unknown identifiers.
	return s.invalidLogin(throttleKey)
}

// resolveLoginIdentity maps a login identifier to exactly one password identity.
//
// Anything containing "@" is treated as an email; everything else is a display name.
// Zero matches and ambiguous display names both answer ErrAccountNotFound so the
// caller spends identical work and returns the same generic error.
func (s *Service) resolveLoginIdentity(ctx context.Context, identifier string) (Identity, error) {
	if strings.Contains(identifier, "@") {
		email, err := NormalizeEmail(identifier)
		if err != nil {
			return Identity{}, ErrAccountNotFound
		}
		return s.repo.FindEmailIdentity(ctx, email)
	}
	identities, err := s.repo.FindEmailIdentitiesByDisplayName(ctx, identifier)
	if err != nil {
		return Identity{}, err
	}
	if len(identities) != 1 {
		return Identity{}, ErrAccountNotFound
	}
	return identities[0], nil
}

// normalizeLoginKey folds an identifier for the in-process failure throttle.
func normalizeLoginKey(identifier string) string {
	return strings.ToLower(strings.TrimSpace(identifier))
}

// invalidLogin preserves failure backoff without making it an account lockout.
// Password verification has already run (against the real or dummy hash), so a
// correct password can still clear the streak while invalid attempts receive 429.
func (s *Service) invalidLogin(email string) error {
	if retryAfter, locked := s.loginFailures.blocked(email); locked {
		return &TooManyAttemptsError{RetryAfter: retryAfter}
	}
	s.loginFailures.failure(email)
	return ErrInvalidCredentials
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

	if err := s.repo.RevokeSession(ctx, record.ID, "logout", s.now()); err != nil {
		return err
	}
	s.recordAudit(ctx, audit.Entry{
		SiteID:     record.SiteID,
		ActorID:    record.UserID,
		Action:     "auth.logout",
		TargetType: "user",
		TargetID:   record.UserID,
	})
	return nil
}

// Me returns the account behind an authenticated principal.
func (s *Service) Me(ctx context.Context, userID string) (UserView, error) {
	user, err := s.repo.FindUser(ctx, userID)
	if err != nil {
		return UserView{}, err
	}
	view := user.View()
	// A pure OAuth account has no email identity; that is not an error here.
	if identity, identityErr := s.repo.FindEmailIdentityByUser(ctx, userID); identityErr == nil {
		view.Email = identity.Email
		// The identity is authoritative. An account that was verified before the
		// account level mirror existed (or before a deployment ran the backfill
		// migration) still reports its true state.
		if identity.VerifiedAt != nil {
			view.EmailVerified = true
		}
	}
	return view, nil
}

// CSRFToken returns the double submit token bound to one refresh token.
//
// The transport layer recomputes it from the refresh cookie before accepting a
// refresh or logout, so a cookie/header pair that is merely self-consistent still
// fails (it was not derived from that token).
func (s *Service) CSRFToken(refreshPlain string) string {
	return s.tokens.CSRFToken(refreshPlain)
}

// IssueSwitchSession mints and persists a session for an account that has just
// redeemed a valid site handoff token.
//
// Authorization is the caller's responsibility: the platform console verifies the
// handoff token and the live membership before calling this method. The method still
// runs the normal session build, which re-reads the membership role from the database
// and refuses an account that is not an active member of siteID.
func (s *Service) IssueSwitchSession(
	ctx context.Context,
	siteID, userID string,
	meta ClientMeta,
) (Session, error) {
	if siteID == "" || userID == "" {
		return Session{}, ErrPermissionToSite
	}
	user, err := s.repo.FindUser(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return Session{}, ErrPermissionToSite
		}
		return Session{}, err
	}
	if user.Status != AccountStatusActive {
		return Session{}, ErrAccountDisabled
	}

	session, record, err := s.buildSession(ctx, user, siteID, "", "", meta, time.Time{})
	if err != nil {
		return Session{}, err
	}
	if err := s.repo.CreateSession(ctx, record); err != nil {
		return Session{}, err
	}
	return session, nil
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
