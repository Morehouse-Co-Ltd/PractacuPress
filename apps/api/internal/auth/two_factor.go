package auth

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Two-factor authentication (FSD F-04).
//
// The account owner can turn TOTP on and off at any time, and an administrator can
// reset a lost device. Passwords stay the first factor; when TOTP is enabled a
// password login yields a short lived challenge instead of a session, and only a
// valid 6 digit code (or a one time recovery code) completes the login.
const (
	// twoFactorChallengeKind is the verification token kind used to make a login
	// challenge single use. Reusing the existing table keeps the schema small and
	// gives conditional consumption for free.
	twoFactorChallengeKind = "two_factor_challenge"
	// twoFactorRecoveryCodes is how many codes one generation produces.
	twoFactorRecoveryCodes = 10
	// recoveryCodeBytes is the entropy behind one code (7 bytes -> 12 base32 chars,
	// roughly 56 bits after the padding bits are dropped).
	recoveryCodeBytes = 7
	// recoveryCodeChunk is the display grouping of one code.
	recoveryCodeChunk = 6
	// recoveryCodeLength is the canonical (separator free) length: base32 encodes 5
	// bits per character, rounded up.
	recoveryCodeLength = (recoveryCodeBytes*8 + 4) / 5
)

// recoveryEncoding is the alphabet recovery codes use.
var recoveryEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// TwoFactorStatus is the self-service view of one account's enrollment.
type TwoFactorStatus struct {
	Enabled                bool
	RecoveryCodesRemaining int
	ConfirmedAt            *time.Time
}

// TwoFactorEnrollment is what a started enrollment hands to the client: the
// plaintext secret is shown exactly once, as part of the otpauth URI, so the user
// can scan it or type it into an authenticator.
type TwoFactorEnrollment struct {
	Secret     string
	OTPAuthURI string
	// QRContent is the payload a QR renderer encodes. It is the otpauth URI; the
	// field exists so a client never has to invent the QR payload itself.
	QRContent string
}

// TwoFactorStatus reports whether the caller has an active authenticator and how
// many recovery codes remain.
//
// It never returns the secret, the recovery codes or the last used step: the
// profile page only needs the switches and the counter.
func (s *Service) TwoFactorStatus(ctx context.Context, userID string) (TwoFactorStatus, error) {
	record, err := s.repo.FindTwoFactor(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrTwoFactorNotFound) {
			return TwoFactorStatus{}, nil
		}
		return TwoFactorStatus{}, err
	}
	status := TwoFactorStatus{
		Enabled:     record.Enabled,
		ConfirmedAt: record.ConfirmedAt,
	}
	if record.Enabled {
		remaining, countErr := s.repo.CountUnusedRecoveryCodes(ctx, userID)
		if countErr != nil {
			return TwoFactorStatus{}, countErr
		}
		status.RecoveryCodesRemaining = remaining
	}
	return status, nil
}

// BeginTwoFactorEnrollment starts (or restarts) an enrollment.
//
// The current password is required even though the caller is authenticated: this is
// the step that mints a long lived shared secret, and an unattended browser must not
// be able to bind an attacker's authenticator to the account. Restarting a pending
// enrollment is allowed; replacing an enabled one is not, so a working second factor
// cannot be swapped out without first disabling it.
func (s *Service) BeginTwoFactorEnrollment(
	ctx context.Context,
	userID, siteID, password string,
) (TwoFactorEnrollment, error) {
	if err := s.verifyAccountPassword(ctx, userID, password); err != nil {
		return TwoFactorEnrollment{}, err
	}

	if record, err := s.repo.FindTwoFactor(ctx, userID); err == nil {
		if record.Enabled {
			return TwoFactorEnrollment{}, ErrTwoFactorAlreadyEnabled
		}
	} else if !errors.Is(err, ErrTwoFactorNotFound) {
		return TwoFactorEnrollment{}, err
	}

	secret, err := newTOTPSecret()
	if err != nil {
		return TwoFactorEnrollment{}, err
	}
	sealed, err := s.secrets.Seal(secret)
	if err != nil {
		return TwoFactorEnrollment{}, err
	}
	if err := s.repo.SaveTwoFactorEnrollment(ctx, userID, sealed, s.now()); err != nil {
		return TwoFactorEnrollment{}, err
	}

	account := userID
	if identity, identityErr := s.repo.FindEmailIdentityByUser(ctx, userID); identityErr == nil && identity.Email != "" {
		account = identity.Email
	}
	uri := totpProvisioningURI(twoFactorIssuer, account, secret)

	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    userID,
		Action:     "auth.2fa.enrollment_started",
		TargetType: "user",
		TargetID:   userID,
	})
	return TwoFactorEnrollment{Secret: secret, OTPAuthURI: uri, QRContent: uri}, nil
}

// ConfirmTwoFactor enables the authenticator and returns the recovery codes.
//
// The plaintext codes are returned exactly once, here; only their hashes are
// stored, so a later visit can show how many are left but never the codes again.
func (s *Service) ConfirmTwoFactor(ctx context.Context, userID, siteID, code string) ([]string, error) {
	record, err := s.repo.FindTwoFactor(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrTwoFactorNotFound) {
			return nil, ErrTwoFactorNotEnrolled
		}
		return nil, err
	}
	if record.Enabled {
		return nil, ErrTwoFactorAlreadyEnabled
	}

	secret, err := s.openTwoFactorSecret(record)
	if err != nil {
		return nil, err
	}
	if _, ok := verifyTOTP(secret, code, s.now(), TOTPDriftSteps); !ok {
		s.recordAudit(ctx, audit.Entry{
			SiteID:     siteID,
			ActorID:    userID,
			Action:     "auth.2fa.confirm_failed",
			TargetType: "user",
			TargetID:   userID,
		})
		return nil, ErrInvalidTwoFactorCode
	}

	codes, hashes, err := newRecoveryCodes(twoFactorRecoveryCodes)
	if err != nil {
		return nil, err
	}
	// The step is deliberately not recorded here: the code that confirmed the
	// authenticator should still be usable for the first login during the same
	// 30 second window, and the replay guard starts from the first login instead.
	if err := s.repo.EnableTwoFactor(ctx, userID, s.now(), hashes); err != nil {
		return nil, err
	}

	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    userID,
		Action:     "auth.2fa.enabled",
		TargetType: "user",
		TargetID:   userID,
		Detail:     map[string]any{"recovery_codes": len(codes)},
	})
	return codes, nil
}

// DisableTwoFactor turns the second factor off.
//
// It requires the current password *and* a working second factor: an attacker who
// only has the password must not be able to downgrade the account, and an
// unattended session alone must not either.
func (s *Service) DisableTwoFactor(ctx context.Context, userID, siteID, password, code string) error {
	if err := s.verifyAccountPassword(ctx, userID, password); err != nil {
		return err
	}
	record, err := s.repo.FindTwoFactor(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrTwoFactorNotFound) {
			return ErrTwoFactorNotEnabled
		}
		return err
	}
	if !record.Enabled {
		return ErrTwoFactorNotEnabled
	}

	method, err := s.verifySecondFactor(ctx, record, code, siteID, "disable")
	if err != nil {
		return err
	}
	if err := s.repo.ClearTwoFactor(ctx, userID); err != nil {
		return err
	}
	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    userID,
		Action:     "auth.2fa.disabled",
		TargetType: "user",
		TargetID:   userID,
		Detail:     map[string]any{"method": method},
	})
	return nil
}

// RegenerateTwoFactorRecoveryCodes replaces every recovery code.
//
// The password plus a working second factor are both required, so a session that
// was left open cannot quietly invalidate the codes the owner wrote down.
func (s *Service) RegenerateTwoFactorRecoveryCodes(
	ctx context.Context,
	userID, siteID, password, code string,
) ([]string, error) {
	if err := s.verifyAccountPassword(ctx, userID, password); err != nil {
		return nil, err
	}
	record, err := s.repo.FindTwoFactor(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrTwoFactorNotFound) {
			return nil, ErrTwoFactorNotEnabled
		}
		return nil, err
	}
	if !record.Enabled {
		return nil, ErrTwoFactorNotEnabled
	}

	method, err := s.verifySecondFactor(ctx, record, code, siteID, "regenerate_recovery_codes")
	if err != nil {
		return nil, err
	}

	codes, hashes, err := newRecoveryCodes(twoFactorRecoveryCodes)
	if err != nil {
		return nil, err
	}
	if err := s.repo.ReplaceRecoveryCodes(ctx, userID, hashes, s.now()); err != nil {
		return nil, err
	}
	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    userID,
		Action:     "auth.2fa.recovery_codes_regenerated",
		TargetType: "user",
		TargetID:   userID,
		Detail:     map[string]any{"method": method, "recovery_codes": len(codes)},
	})
	return codes, nil
}

// startTwoFactorChallenge is called by the password login once the password is
// proven. It returns ErrTwoFactorRequired wrapped in a typed error carrying the
// challenge, or nil when the account has no active authenticator.
func (s *Service) startTwoFactorChallenge(
	ctx context.Context,
	user UserAccount,
	siteID string,
) error {
	record, err := s.repo.FindTwoFactor(ctx, user.ID)
	if err != nil {
		if errors.Is(err, ErrTwoFactorNotFound) {
			return nil
		}
		return err
	}
	if !record.Enabled {
		return nil
	}

	challenge, err := s.tokens.IssueTwoFactorChallenge(user.ID, siteID)
	if err != nil {
		return err
	}
	// The challenge itself is only a signed envelope; the row is what makes it
	// single use. It expires with the token so a stale row cannot be resurrected.
	if err := s.repo.CreateVerificationToken(ctx, VerificationToken{
		ID:        uuid.Must(uuid.NewV7()).String(),
		UserID:    user.ID,
		Kind:      twoFactorChallengeKind,
		TokenHash: HashOpaqueToken(challenge.JTI),
		ExpiresAt: challenge.ExpiresAt,
		CreatedAt: s.now(),
	}); err != nil {
		return err
	}

	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    user.ID,
		Action:     "auth.2fa.challenge_issued",
		TargetType: "user",
		TargetID:   user.ID,
	})
	return &TwoFactorRequiredError{ChallengeToken: challenge.Token, ExpiresAt: challenge.ExpiresAt}
}

// VerifyTwoFactorLogin completes a login that stopped at the challenge.
//
// The challenge is single use (the verification token row is consumed), site bound
// and expires after five minutes. A wrong code counts towards the same in-process
// lockout as a wrong password, so six digit guessing is throttled exactly like
// password guessing.
func (s *Service) VerifyTwoFactorLogin(
	ctx context.Context,
	siteID, challengeToken, code string,
	meta ClientMeta,
) (Session, error) {
	if challengeToken == "" || code == "" {
		return Session{}, ErrTwoFactorChallengeInvalid
	}

	userID, challengeSite, jti, err := s.tokens.VerifyTwoFactorChallenge(challengeToken)
	if err != nil {
		return Session{}, ErrTwoFactorChallengeInvalid
	}
	// A challenge minted on one site must not mint a session on another.
	if challengeSite != siteID {
		return Session{}, ErrTwoFactorChallengeInvalid
	}

	stored, err := s.repo.FindVerificationToken(ctx, HashOpaqueToken(jti))
	if err != nil {
		if errors.Is(err, ErrVerificationTokenNotFound) {
			return Session{}, ErrTwoFactorChallengeInvalid
		}
		return Session{}, err
	}
	if stored.Kind != twoFactorChallengeKind || !stored.Live(s.now()) {
		return Session{}, ErrTwoFactorChallengeInvalid
	}

	user, err := s.repo.FindUser(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return Session{}, ErrTwoFactorChallengeInvalid
		}
		return Session{}, err
	}
	if user.Status != AccountStatusActive {
		return Session{}, ErrAccountDisabled
	}

	record, err := s.repo.FindTwoFactor(ctx, userID)
	if err != nil || !record.Enabled {
		return Session{}, ErrTwoFactorNotEnabled
	}

	method, err := s.verifySecondFactor(ctx, record, code, siteID, "login")
	if err != nil {
		return Session{}, err
	}

	// Burn the challenge only after the code is proven: a typo must not force a
	// fresh password login, while a successful redemption must never be replayable.
	consumed, err := s.repo.ConsumeVerificationToken(ctx, stored.ID, s.now())
	if err != nil {
		return Session{}, err
	}
	if !consumed {
		return Session{}, ErrTwoFactorChallengeInvalid
	}

	session, recordRow, err := s.buildSession(ctx, user, siteID, "", "", meta, time.Time{})
	if err != nil {
		return Session{}, err
	}
	if err := s.repo.CreateSession(ctx, recordRow); err != nil {
		return Session{}, err
	}

	s.loginFailures.success(throttleKeyForUser(userID))
	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    userID,
		Action:     "auth.2fa.login_verified",
		TargetType: "user",
		TargetID:   userID,
		Detail:     map[string]any{"method": method},
	})
	return session, nil
}

// ResetMemberTwoFactor lets a platform administrator clear a member's authenticator.
//
// It exists for the lost-device case: without it an account whose phone is gone is
// locked out forever. Only a platform administrator may do it (a site administrator
// could otherwise downgrade a peer account), and every reset is audited.
func (s *Service) ResetMemberTwoFactor(
	ctx context.Context,
	actor Principal,
	siteID, targetUserID string,
) error {
	if siteID == "" || targetUserID == "" {
		return fmt.Errorf("%w: site and member are required", ErrInvalidInput)
	}
	if actor.SiteID != siteID {
		return ErrPermissionToSite
	}
	if actor.Role != site.RolePlatformAdmin {
		return ErrActionNotAllowed
	}
	// A platform administrator must not clear its own second factor through this
	// endpoint: together with a stolen session and the password that would silently
	// bypass TOTP. A locked-out administrator needs another administrator or direct
	// database access, which is the same bar as any other recovery of last resort.
	if targetUserID == actor.UserID {
		return ErrActionNotAllowed
	}
	if _, err := s.repo.FindMembershipRole(ctx, siteID, targetUserID); err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return ErrAccountNotFound
		}
		return err
	}

	// Idempotent: resetting an account that has no authenticator is a no-op, which
	// keeps an operator retry safe.
	if _, err := s.repo.FindTwoFactor(ctx, targetUserID); err != nil {
		if errors.Is(err, ErrTwoFactorNotFound) {
			return nil
		}
		return err
	}
	if err := s.repo.ClearTwoFactor(ctx, targetUserID); err != nil {
		return err
	}
	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    actor.UserID,
		Action:     "auth.2fa.reset",
		TargetType: "user",
		TargetID:   targetUserID,
		Detail:     map[string]any{"by": "platform_admin"},
	})
	// Sessions are deliberately left alone: an administrator reset is a recovery
	// action for a lost device, and revoking everything would also sign the owner out
	// of the browser they are using to recover.
	return nil
}

// verifySecondFactor accepts one TOTP code or one recovery code and enforces the
// replay guard. It returns which method succeeded, for the audit trail.
func (s *Service) verifySecondFactor(
	ctx context.Context,
	record TwoFactorRecord,
	code, siteID, purpose string,
) (string, error) {
	key := throttleKeyForUser(record.UserID)
	if retryAfter, locked := s.loginFailures.blocked(key); locked {
		return "", &TooManyAttemptsError{RetryAfter: retryAfter}
	}

	method, ok := "", false
	replayed := false
	if isTOTPCode(code) {
		ok, replayed = s.verifyTOTPForRecord(ctx, record, code)
		if replayed {
			s.loginFailures.failure(key)
			s.recordAudit(ctx, audit.Entry{
				SiteID:     siteID,
				ActorID:    record.UserID,
				Action:     "auth.2fa.replay_rejected",
				TargetType: "user",
				TargetID:   record.UserID,
				Detail:     map[string]any{"purpose": purpose},
			})
			return "", ErrTwoFactorReplayed
		}
		if ok {
			method = "totp"
		}
	} else {
		recovered, err := s.verifyRecoveryCode(ctx, record.UserID, code)
		if err != nil {
			return "", err
		}
		if recovered {
			method, ok = "recovery_code", true
		}
	}

	if !ok {
		s.loginFailures.failure(key)
		s.recordAudit(ctx, audit.Entry{
			SiteID:     siteID,
			ActorID:    record.UserID,
			Action:     "auth.2fa.failed",
			TargetType: "user",
			TargetID:   record.UserID,
			Detail:     map[string]any{"purpose": purpose},
		})
		return "", ErrInvalidTwoFactorCode
	}
	s.loginFailures.success(key)
	return method, nil
}

// verifyTOTPForRecord opens the sealed secret, checks the code and consumes its
// time step. The second result reports a replay: the code was valid but its step had
// already been accepted, which is a different answer from a wrong code.
func (s *Service) verifyTOTPForRecord(
	ctx context.Context,
	record TwoFactorRecord,
	code string,
) (matched bool, replayed bool) {
	secret, err := s.openTwoFactorSecret(record)
	if err != nil {
		return false, false
	}
	step, ok := verifyTOTP(secret, code, s.now(), TOTPDriftSteps)
	if !ok {
		return false, false
	}
	consumed, err := s.repo.ConsumeTwoFactorStep(ctx, record.UserID, step)
	if err != nil {
		return false, false
	}
	if !consumed {
		// A step at or below the stored one is a replay: the same 30 second code has
		// already been accepted once, so it must not open a second session.
		return false, true
	}
	return true, false
}

// verifyRecoveryCode consumes one recovery code.
func (s *Service) verifyRecoveryCode(ctx context.Context, userID, code string) (bool, error) {
	normalized := normalizeRecoveryCode(code)
	if len(normalized) != recoveryCodeLength {
		return false, nil
	}
	consumed, err := s.repo.ConsumeRecoveryCode(
		ctx, userID, HashOpaqueToken(normalized), s.now(),
	)
	if err != nil {
		return false, err
	}
	return consumed, nil
}

// openTwoFactorSecret decrypts the stored secret.
func (s *Service) openTwoFactorSecret(record TwoFactorRecord) (string, error) {
	secret, err := s.secrets.Open(record.Secret)
	if err != nil {
		return "", ErrTwoFactorUnavailable
	}
	return secret, nil
}

// verifyAccountPassword re-proves the caller's password for a sensitive change.
func (s *Service) verifyAccountPassword(ctx context.Context, userID, password string) error {
	if password == "" {
		return invalidField("password", "required", "password is required")
	}
	identity, err := s.repo.FindEmailIdentityByUser(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return ErrCurrentPasswordInvalid
		}
		return err
	}
	if identity.PasswordHash == "" {
		return ErrCurrentPasswordInvalid
	}
	matches, err := s.hasher.Verify(ctx, password, identity.PasswordHash)
	if err != nil {
		return err
	}
	if !matches {
		return ErrCurrentPasswordInvalid
	}
	return nil
}

// throttleKeyForUser namespaces the shared login failure table. A 2FA streak must
// not be cleared by a successful password step (which is what happens on the same
// email key), and vice versa.
func throttleKeyForUser(userID string) string { return "2fa:" + userID }

// isTOTPCode reports whether a submission is shaped like a six digit TOTP code.
// Anything else is treated as a recovery code, so a user can paste either.
func isTOTPCode(code string) bool {
	trimmed := strings.TrimSpace(code)
	if len(trimmed) != TOTPDigits {
		return false
	}
	for _, r := range trimmed {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// newRecoveryCodes mints one generation of codes and their storage hashes.
func newRecoveryCodes(count int) ([]string, []string, error) {
	codes := make([]string, 0, count)
	hashes := make([]string, 0, count)
	seen := make(map[string]struct{}, count)
	for len(codes) < count {
		buf := make([]byte, recoveryCodeBytes)
		if _, err := rand.Read(buf); err != nil {
			return nil, nil, fmt.Errorf("auth: generate recovery code: %w", err)
		}
		normalized := recoveryEncoding.EncodeToString(buf)
		if _, duplicate := seen[normalized]; duplicate {
			continue
		}
		seen[normalized] = struct{}{}
		// Store the hash of the canonical form, display the grouped form.
		hashes = append(hashes, hashRecoveryCode(normalized))
		codes = append(codes, groupRecoveryCode(normalized))
	}
	return codes, hashes, nil
}

// normalizeRecoveryCode canonicalises user input for hashing.
func normalizeRecoveryCode(code string) string {
	replacer := strings.NewReplacer("-", "", " ", "", "\t", "", "\n", "")
	return strings.ToUpper(replacer.Replace(strings.TrimSpace(code)))
}

// groupRecoveryCode renders a canonical code as two visual chunks.
func groupRecoveryCode(code string) string {
	if len(code) <= recoveryCodeChunk {
		return code
	}
	return code[:recoveryCodeChunk] + "-" + code[recoveryCodeChunk:]
}

// hashRecoveryCode is the storage form of a canonical code.
//
// A plain SHA-256 is enough: a code carries ~56 bits of entropy and is rate limited
// by the same lockout as a password, so there is nothing to brute force, and the
// fast hash keeps the lookup index friendly.
func hashRecoveryCode(canonical string) string {
	return HashOpaqueToken(canonical)
}
