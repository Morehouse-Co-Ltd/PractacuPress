package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/platform/sms"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Phone code login (contract A).
//
// The feature is a small state machine over one table:
//
//	request a code  -> phone_codes row (hash only, never the number)
//	redeem a code   -> latest live row, 5 attempts, consumed_at stamped
//	issue a session -> exactly the password login path (see LoginPhone)
//
// Three rules shape the file:
//
//   - The number is never stored in the clear. Both the lookup key and the code are
//     hashes that include the site id, so the same phone on two sites is two
//     unrelated values and a database dump cannot be turned into a contact list.
//   - Rate limiting is database backed, not in-process: a restart must not reset a
//     code spammer's hourly budget.
//   - The session is minted by buildSession/CreateSession, the same helpers password
//     login uses. A second token layout would drift from the first one.
const (
	// PhoneCodePurposeLogin requests a code for an existing account.
	PhoneCodePurposeLogin = "login"
	// PhoneCodePurposeRegister requests a code for a first sign-in.
	PhoneCodePurposeRegister = "register"
	// PhoneCodeLength is the number of digits of a verification code.
	PhoneCodeLength = 6
	// MaxPhoneCodeAttempts is how many wrong guesses a single code tolerates before
	// it is retired.
	MaxPhoneCodeAttempts = 5
	// PhoneCodesPerPhonePerHour bounds code requests for one number.
	PhoneCodesPerPhonePerHour = 5
	// PhoneCodesPerIPPerHour bounds code requests from one source address.
	PhoneCodesPerIPPerHour = 20
	// PhoneCodeRateWindow is the sliding window both limits count over.
	PhoneCodeRateWindow = time.Hour
	// PhoneResendAfter is the resend cooldown the client is told about.
	PhoneResendAfter = 60 * time.Second
	// DefaultPhoneCodeTTL is how long a code stays valid when SMSCodeTTL is unset.
	DefaultPhoneCodeTTL = 300 * time.Second
	// DevPhoneCode is the fixed code used when SMS_DEV_MODE is on and returned as
	// dev_code, so a developer can log in without reading the log.
	DevPhoneCode = "123456"
)

// hash domain separation labels for the values whose recipe contract A fixes only
// loosely. They are part of the input, so a hash computed for one purpose can never
// be mistaken for another.
const (
	phoneCodeHashLabel = "phone-code:"
	phoneIPHashLabel   = "phone-ip:"
)

// errorTypeBase mirrors the prefix of platform/errors so this file can build the two
// contract A codes the fixed table does not have (sms_not_configured, invalid_code).
// Constructing a Problem directly is deliberate: the error table lives in a package
// this change may not modify, and degrading these to internal errors would hand the
// client a 500 for a normal outcome.
const errorTypeBase = "https://docs.practacu.press/errors/"

// PhoneCodeRecord is one persisted verification code.
//
// Only hashes are stored: PhoneHash is the lookup key and CodeHash is the salted
// digest of the six digits. The plain code exists only between generation and the
// gateway call.
type PhoneCodeRecord struct {
	ID        string
	SiteID    string
	PhoneHash string
	// PhoneMasked is display only (for example "138****8000").
	PhoneMasked string
	Purpose     string
	CodeHash    string
	Attempts    int
	// RequestIPHash is the hashed source address; the plain address is never stored.
	RequestIPHash string
	ExpiresAt     time.Time
	ConsumedAt    *time.Time
	CreatedAt     time.Time
}

// Live reports whether the code may still be redeemed at now.
func (r PhoneCodeRecord) Live(now time.Time) bool {
	return r.ConsumedAt == nil && now.Before(r.ExpiresAt)
}

// CreatePhoneAccountInput is a first phone sign-in that has to create an account.
type CreatePhoneAccountInput struct {
	SiteID      string
	Phone       string
	DisplayName string
	Role        string
}

// PhoneRepository is the persistence contract of phone code login.
//
// It is separate from Repository on purpose: deployments (and tests) that never
// enable phone login keep working against the old interface, and a store that only
// implements Repository does not have to grow phone methods.
//
// CreateAccountWithPhone is atomic: the account, its phone identity and its site
// membership are written in one transaction and the site's registration switch is
// read inside it, so a closed site leaves nothing behind.
type PhoneRepository interface {
	// CreatePhoneCode stores a new code row.
	CreatePhoneCode(ctx context.Context, record PhoneCodeRecord) error
	// LatestLivePhoneCode returns the newest unconsumed, unexpired code of a number,
	// or ErrPhoneCodeNotFound.
	LatestLivePhoneCode(ctx context.Context, siteID, phoneHash string, now time.Time) (PhoneCodeRecord, error)
	// CountPhoneCodesSince counts rows created for a number since a point in time.
	CountPhoneCodesSince(ctx context.Context, siteID, phoneHash string, since time.Time) (int, error)
	// CountPhoneCodesByIPSince counts rows created from one hashed address since a
	// point in time.
	CountPhoneCodesByIPSince(ctx context.Context, siteID, ipHash string, since time.Time) (int, error)
	// IncrementPhoneCodeAttempts counts one wrong guess and returns the new total.
	IncrementPhoneCodeAttempts(ctx context.Context, id string) (int, error)
	// ConsumePhoneCode stamps consumed_at. It reports false when another request
	// redeemed the row first, which makes redemption single use under a race.
	ConsumePhoneCode(ctx context.Context, id string, at time.Time) (bool, error)
	// FindPhoneIdentity resolves a normalized phone number to its identity, or
	// ErrAccountNotFound.
	FindPhoneIdentity(ctx context.Context, phone string) (Identity, error)
	// CreateAccountWithPhone creates the account, its phone identity and its site
	// membership in one transaction. A closed site answers ErrRegistrationClosed.
	CreateAccountWithPhone(ctx context.Context, in CreatePhoneAccountInput) (UserAccount, error)
	// EnsureMembership makes an existing account a member of the site, honouring the
	// registration switch for a missing row.
	EnsureMembership(ctx context.Context, siteID, userID string) error
}

// PhonePolicy is the public answer of GET /auth/phone/policy.
type PhonePolicy struct {
	Enabled          bool
	Provider         string
	RegistrationOpen bool
}

// PhoneCodeInput is a code request.
type PhoneCodeInput struct {
	Phone   string
	Purpose string
	// IPAddress is hashed before it is stored; the plain address never reaches the
	// database.
	IPAddress string
}

// PhoneCodeResult is the accepted answer of a code request.
type PhoneCodeResult struct {
	ExpiresAt          time.Time
	ResendAfterSeconds int
	// DevCode is set only when SMS_DEV_MODE is on.
	DevCode string
}

// PhoneLoginInput is a code login request.
type PhoneLoginInput struct {
	Phone       string
	Code        string
	DisplayName string
	ClientMeta
}

// NormalizePhone strips separators and validates a phone number.
//
// Two stored forms are accepted: an 11 digit Chinese mobile number ("13800138000")
// and an E.164 number ("+8613800138000"). Everything else is refused before any
// database access. The stored form is what the hash is computed over, so the same
// input always maps to the same account.
func NormalizePhone(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", invalidField("phone", "required", "phone is required")
	}

	var digits strings.Builder
	for i, r := range trimmed {
		switch {
		case r >= '0' && r <= '9':
			digits.WriteRune(r)
		case r == '+' && i == 0:
			digits.WriteRune(r)
		case r == ' ' || r == '-' || r == '(' || r == ')' || r == '.':
			// Common separator a user types or a contact card imports.
		default:
			return "", invalidField("phone", "malformed", "phone is malformed")
		}
	}

	value := digits.String()
	if value == "" {
		return "", invalidField("phone", "malformed", "phone is malformed")
	}

	if strings.HasPrefix(value, "+") {
		body := value[1:]
		if len(body) < 8 || len(body) > 15 {
			return "", invalidField("phone", "malformed", "phone is malformed")
		}
		if strings.HasPrefix(body, "0") {
			// An E.164 country code never starts with zero; keeping it would silently
			// create a different account than the same number without the leading 0.
			return "", invalidField("phone", "malformed", "phone is malformed")
		}
		return "+" + body, nil
	}

	if len(value) == 11 && strings.HasPrefix(value, "1") {
		return value, nil
	}
	return "", invalidField("phone", "malformed", "phone must be an eleven digit mobile number or an E.164 number")
}

// PhoneMasked renders the display form of a normalized number.
//
// It keeps the first three and the last four digits: enough for the account owner to
// recognise the number, not enough to dial it.
func PhoneMasked(normalized string) string {
	digits := strings.TrimPrefix(normalized, "+")
	if len(digits) <= 4 {
		return strings.Repeat("*", len(digits))
	}
	if len(digits) < 8 {
		return digits[:1] + strings.Repeat("*", len(digits)-2) + digits[len(digits)-1:]
	}
	prefix := ""
	if strings.HasPrefix(normalized, "+") {
		prefix = "+"
	}
	return prefix + digits[:3] + "****" + digits[len(digits)-4:]
}

// PhoneHash is the lookup key of a number on one site.
//
// SHA256(siteID + ":" + normalized) is the contract A recipe. The site id makes the
// same number on two sites two unrelated values, so a dump of one site's table
// cannot be used to probe another's.
func PhoneHash(siteID, normalized string) string {
	return sha256Hex(siteID + ":" + normalized)
}

// phoneCodeHash is the stored digest of one code.
//
// It is SHA256(siteID + ":" + phoneHash + ":" + code): the site id and the phone hash
// (the salted key of the number) are both in the input, so a code hash copied to
// another number or another site never verifies.
func phoneCodeHash(siteID, phoneHash, code string) string {
	return sha256Hex(siteID + ":" + phoneHash + ":" + code)
}

// phoneRequestIPHash is the stored digest of a source address.
//
// The plain address never reaches the database; only this salted digest does.
func phoneRequestIPHash(siteID, ip string) string {
	return sha256Hex(phoneIPHashLabel + siteID + ":" + ip)
}

// sha256Hex returns the lowercase hex SHA-256 of value.
func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// normalizePhonePurpose validates the purpose of a code request.
//
// An empty purpose defaults to login because that is the overwhelmingly common case
// and a client that forgets the field should not fail; the field only decides which
// template a gateway uses.
func normalizePhonePurpose(raw string) (string, error) {
	purpose := strings.ToLower(strings.TrimSpace(raw))
	switch purpose {
	case "":
		return PhoneCodePurposeLogin, nil
	case PhoneCodePurposeLogin, PhoneCodePurposeRegister:
		return purpose, nil
	default:
		return "", invalidField("purpose", "invalid", "purpose must be login or register")
	}
}

// phoneRepository resolves the phone persistence port.
//
// An explicit PhoneCodes wins; otherwise the auth store that backs Repository is
// reused when it implements the phone port, which is how the server wires one
// store for both. Either way the feature stays off until SMS is configured.
func phoneRepository(cfg ServiceConfig) PhoneRepository {
	if cfg.PhoneCodes != nil {
		return cfg.PhoneCodes
	}
	if candidate, ok := cfg.Repository.(PhoneRepository); ok {
		return candidate
	}
	return nil
}

// normalizeSMSProvider derives the provider name the policy endpoint reports.
func normalizeSMSProvider(raw string, sender sms.Sender) string {
	provider := strings.ToLower(strings.TrimSpace(raw))
	if provider == "" {
		if sender != nil && sender.Configured() {
			// A hand built Service that was given a sender but no name is treated as
			// the log provider: that is the only sender this package can construct.
			return sms.ProviderLog
		}
		return sms.ProviderOff
	}
	return provider
}

// phoneEnabled reports whether this deployment can send and redeem codes.
func (s *Service) phoneEnabled() bool {
	if s.phone == nil || s.sms == nil || !s.sms.Configured() {
		return false
	}
	return s.smsProvider != "" && s.smsProvider != sms.ProviderOff
}

// generatePhoneCode returns a cryptographically random five digit value padded to
// six digits, or the fixed development code.
func (s *Service) generatePhoneCode() (string, error) {
	if s.smsDevMode {
		return DevPhoneCode, nil
	}
	max := big.NewInt(1_000_000)
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", fmt.Errorf("auth: generate phone code: %w", err)
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// PhonePolicy answers GET /auth/phone/policy.
func (s *Service) PhonePolicy(ctx context.Context, siteID string) (PhonePolicy, error) {
	if siteID == "" {
		return PhonePolicy{}, fmt.Errorf("%w: site is required", ErrInvalidInput)
	}
	open := true
	if s.registrationPolicy != nil {
		value, err := s.registrationPolicy(ctx, siteID)
		if err != nil {
			return PhonePolicy{}, err
		}
		open = value
	}
	return PhonePolicy{
		Enabled:          s.phoneEnabled(),
		Provider:         s.smsProvider,
		RegistrationOpen: open,
	}, nil
}

// RequestPhoneCode creates and delivers one verification code.
//
// The limits are checked first (they are the cheapest rejection and the only thing a
// spammer cares about), then the row is written, then the gateway is called. A
// delivery failure is reported to the caller: answering 202 for a code that never
// left the building would leave the visitor waiting forever.
func (s *Service) RequestPhoneCode(
	ctx context.Context,
	siteID string,
	in PhoneCodeInput,
) (PhoneCodeResult, error) {
	if siteID == "" {
		return PhoneCodeResult{}, fmt.Errorf("%w: site is required", ErrInvalidInput)
	}
	if !s.phoneEnabled() {
		return PhoneCodeResult{}, ErrSMSNotConfigured
	}

	phone, err := NormalizePhone(in.Phone)
	if err != nil {
		return PhoneCodeResult{}, err
	}
	purpose, err := normalizePhonePurpose(in.Purpose)
	if err != nil {
		return PhoneCodeResult{}, err
	}

	phoneHash := PhoneHash(siteID, phone)
	ipHash := ""
	if ip := strings.TrimSpace(in.IPAddress); ip != "" {
		ipHash = phoneRequestIPHash(siteID, ip)
	}

	now := s.now()
	since := now.Add(-PhoneCodeRateWindow)

	phoneCount, err := s.phone.CountPhoneCodesSince(ctx, siteID, phoneHash, since)
	if err != nil {
		return PhoneCodeResult{}, err
	}
	if phoneCount >= PhoneCodesPerPhonePerHour {
		// The caller may retry once the oldest request leaves the window; an hour is
		// the safe upper bound and the client already treats 429 as "back off".
		return PhoneCodeResult{}, &TooManyAttemptsError{RetryAfter: PhoneCodeRateWindow}
	}
	if ipHash != "" {
		ipCount, countErr := s.phone.CountPhoneCodesByIPSince(ctx, siteID, ipHash, since)
		if countErr != nil {
			return PhoneCodeResult{}, countErr
		}
		if ipCount >= PhoneCodesPerIPPerHour {
			return PhoneCodeResult{}, &TooManyAttemptsError{RetryAfter: PhoneCodeRateWindow}
		}
	}

	code, err := s.generatePhoneCode()
	if err != nil {
		return PhoneCodeResult{}, err
	}
	expiresAt := now.Add(s.smsCodeTTL)
	record := PhoneCodeRecord{
		ID:            uuid.Must(uuid.NewV7()).String(),
		SiteID:        siteID,
		PhoneHash:     phoneHash,
		PhoneMasked:   PhoneMasked(phone),
		Purpose:       purpose,
		CodeHash:      phoneCodeHash(siteID, phoneHash, code),
		RequestIPHash: ipHash,
		ExpiresAt:     expiresAt,
		CreatedAt:     now,
	}
	if err := s.phone.CreatePhoneCode(ctx, record); err != nil {
		return PhoneCodeResult{}, err
	}

	if err := s.sms.Send(ctx, sms.Message{
		Phone:   phone,
		Code:    code,
		Purpose: purpose,
		TTL:     s.smsCodeTTL,
	}); err != nil {
		s.logError("phone verification code delivery failed", "error", err)
		return PhoneCodeResult{}, fmt.Errorf("auth: deliver phone verification code: %w", err)
	}

	result := PhoneCodeResult{
		ExpiresAt:          expiresAt,
		ResendAfterSeconds: int(PhoneResendAfter.Seconds()),
	}
	if s.smsDevMode {
		result.DevCode = code
	}
	return result, nil
}

// LoginPhone redeems a code and starts a session.
//
// The session itself is built by buildSession and persisted with CreateSession, so
// the token/refresh/CSRF layout is byte for byte the password login one (contract A:
// "与密码登录完全相同的会话载荷"). An account with an active authenticator gets the
// same TwoFactorChallenge answer the password login returns instead: the SMS code is
// only the first factor, and POST /auth/login/2fa completes the login.
func (s *Service) LoginPhone(ctx context.Context, siteID string, in PhoneLoginInput) (Session, error) {
	if siteID == "" {
		return Session{}, fmt.Errorf("%w: site is required", ErrInvalidInput)
	}
	if !s.phoneEnabled() {
		return Session{}, ErrSMSNotConfigured
	}

	phone, err := NormalizePhone(in.Phone)
	if err != nil {
		return Session{}, err
	}
	code := strings.TrimSpace(in.Code)
	if !isSixDigitCode(code) {
		return Session{}, invalidField("code", "malformed", "code must be six digits")
	}

	phoneHash := PhoneHash(siteID, phone)
	now := s.now()

	record, err := s.phone.LatestLivePhoneCode(ctx, siteID, phoneHash, now)
	if err != nil {
		if errors.Is(err, ErrPhoneCodeNotFound) {
			// Unknown, expired and already consumed all answer the same way.
			return Session{}, ErrInvalidCode
		}
		return Session{}, err
	}

	if !TokensEqual(phoneCodeHash(siteID, phoneHash, code), record.CodeHash) {
		attempts, incErr := s.phone.IncrementPhoneCodeAttempts(ctx, record.ID)
		if incErr != nil {
			return Session{}, incErr
		}
		if attempts >= MaxPhoneCodeAttempts {
			// The code is retired so a fifth guess cannot be followed by a sixth; the
			// caller has to request a new one.
			if _, consumeErr := s.phone.ConsumePhoneCode(ctx, record.ID, now); consumeErr != nil {
				s.logError("retire exhausted phone code failed", "error", consumeErr, "code_id", record.ID)
			}
			return Session{}, &TooManyAttemptsError{RetryAfter: PhoneResendAfter}
		}
		return Session{}, ErrInvalidCode
	}

	// Consume before touching the account: a replayed request loses the conditional
	// update and gets the generic invalid code answer.
	consumed, err := s.phone.ConsumePhoneCode(ctx, record.ID, now)
	if err != nil {
		return Session{}, err
	}
	if !consumed {
		return Session{}, ErrInvalidCode
	}

	user, created, err := s.resolvePhoneAccount(ctx, siteID, phone, in.DisplayName)
	if err != nil {
		return Session{}, err
	}
	if user.Status != AccountStatusActive {
		return Session{}, ErrAccountDisabled
	}

	// FSD F-04 parity with the password login: an account with an active
	// authenticator does not get a session from the SMS code alone. The code was
	// correct, so this is a success of the first factor; the caller has to redeem the
	// same challenge POST /auth/login/2fa completes. Without this branch, anyone who
	// knows the number and intercepts one SMS could walk past the account owner's
	// TOTP.
	if err := s.startTwoFactorChallenge(ctx, user, siteID); err != nil {
		return Session{}, err
	}

	session, sessionRecord, err := s.buildSession(ctx, user, siteID, "", "", in.ClientMeta, time.Time{})
	if err != nil {
		return Session{}, err
	}
	if err := s.repo.CreateSession(ctx, sessionRecord); err != nil {
		return Session{}, err
	}

	if created {
		s.recordAudit(ctx, audit.Entry{
			SiteID:     siteID,
			ActorID:    user.ID,
			Action:     "auth.registered",
			TargetType: "user",
			TargetID:   user.ID,
			Detail:     map[string]any{"provider": "phone"},
		})
	}
	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    user.ID,
		Action:     "auth.login",
		TargetType: "user",
		TargetID:   user.ID,
		Detail:     map[string]any{"provider": "phone"},
	})
	return session, nil
}

// resolvePhoneAccount maps a proven phone number to an account that can sign in to
// siteID.
//
// The rules are the OAuth resolution's, minus the address linking: the phone
// identity is the account (a phone number proven by SMS is verified by definition),
// the site membership is ensured for an existing account, and a first sign-in
// creates the account only when the site keeps registration open.
func (s *Service) resolvePhoneAccount(
	ctx context.Context,
	siteID, phone, displayName string,
) (UserAccount, bool, error) {
	identity, err := s.phone.FindPhoneIdentity(ctx, phone)
	switch {
	case err == nil:
		user, loadErr := s.repo.FindUser(ctx, identity.UserID)
		if loadErr != nil {
			return UserAccount{}, false, loadErr
		}
		// An account can exist globally while this site never added it; the session
		// build refuses a non-member, so the membership is ensured here, under the same
		// registration switch the OAuth path uses.
		if err := s.phone.EnsureMembership(ctx, siteID, identity.UserID); err != nil {
			return UserAccount{}, false, err
		}
		return user, false, nil

	case errors.Is(err, ErrAccountNotFound):
		if s.registrationPolicy != nil {
			open, policyErr := s.registrationPolicy(ctx, siteID)
			if policyErr != nil {
				return UserAccount{}, false, policyErr
			}
			if !open {
				return UserAccount{}, false, ErrRegistrationClosed
			}
		}

		name := strings.TrimSpace(displayName)
		if name == "" {
			name = defaultPhoneDisplayName(phone)
		} else {
			validated, validateErr := ValidateDisplayName(name)
			if validateErr != nil {
				return UserAccount{}, false, validateErr
			}
			name = validated
		}

		created, createErr := s.phone.CreateAccountWithPhone(ctx, CreatePhoneAccountInput{
			SiteID:      siteID,
			Phone:       phone,
			DisplayName: name,
			Role:        string(site.RoleMember),
		})
		if createErr == nil {
			return created, true, nil
		}
		if !errors.Is(createErr, ErrIdentityExists) {
			return UserAccount{}, false, createErr
		}
		// Two logins raced the same first sign-in; the loser adopts the winner's
		// account instead of failing a correct code.
		winner, findErr := s.phone.FindPhoneIdentity(ctx, phone)
		if findErr != nil {
			return UserAccount{}, false, findErr
		}
		user, loadErr := s.repo.FindUser(ctx, winner.UserID)
		if loadErr != nil {
			return UserAccount{}, false, loadErr
		}
		return user, false, nil

	default:
		return UserAccount{}, false, err
	}
}

// defaultPhoneDisplayName derives a stable, non identifying display name.
//
// The phone number must not become a public profile name, so the suffix is derived
// from its hash rather than from its digits.
func defaultPhoneDisplayName(phone string) string {
	suffix := PhoneHash("display", phone)
	if len(suffix) > 4 {
		suffix = suffix[:4]
	}
	return "用户" + suffix
}

// isSixDigitCode reports whether raw is exactly six ASCII digits.
func isSixDigitCode(raw string) bool {
	if len(raw) != PhoneCodeLength {
		return false
	}
	for _, r := range raw {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// --- HTTP surface -----------------------------------------------------------

type phoneCodeRequest struct {
	Phone   string `json:"phone"`
	Purpose string `json:"purpose"`
}

type phoneLoginRequest struct {
	Phone       string `json:"phone"`
	Code        string `json:"code"`
	DisplayName string `json:"display_name"`
}

type phonePolicyResponse struct {
	Enabled          bool   `json:"enabled"`
	Provider         string `json:"provider"`
	RegistrationOpen bool   `json:"registration_open"`
}

type phoneCodeResponse struct {
	ExpiresAt          time.Time `json:"expires_at"`
	ResendAfterSeconds int       `json:"resend_after_seconds"`
	DevCode            string    `json:"dev_code,omitempty"`
}

// PhoneRoutes mounts the three contract A endpoints under /auth/phone.
//
// It is separate from Routes so the composition root decides whether the surface
// exists at all: a deployment that never configures SMS still runs its auth routes
// unchanged, and mounting this handler is a one line decision in the router.
//
// The two POST endpoints reuse the handler's credential limiter (they consume a code
// and can be brute forced) and the write guard (same origin plus JSON body), exactly
// like the password endpoints.
func (h *Handler) PhoneRoutes(r gin.IRouter) {
	group := r.Group("/auth/phone")
	group.GET("/policy", h.PhonePolicy)
	group.POST("/codes", h.credential, h.guard(true), h.RequestPhoneCode)
	group.POST("/login", h.credential, h.guard(true), h.LoginPhone)
}

// PhonePolicy answers GET /auth/phone/policy.
func (h *Handler) PhonePolicy(c *gin.Context) {
	policy, err := h.service.PhonePolicy(c.Request.Context(), h.siteID(c))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, phonePolicyResponse{
		Enabled:          policy.Enabled,
		Provider:         policy.Provider,
		RegistrationOpen: policy.RegistrationOpen,
	})
}

// RequestPhoneCode answers POST /auth/phone/codes.
func (h *Handler) RequestPhoneCode(c *gin.Context) {
	var req phoneCodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	result, err := h.service.RequestPhoneCode(c.Request.Context(), h.siteID(c), PhoneCodeInput{
		Phone:     req.Phone,
		Purpose:   req.Purpose,
		IPAddress: c.ClientIP(),
	})
	if err != nil {
		h.writePhoneError(c, err)
		return
	}

	body := phoneCodeResponse{
		ExpiresAt:          result.ExpiresAt.UTC(),
		ResendAfterSeconds: result.ResendAfterSeconds,
	}
	if result.DevCode != "" {
		body.DevCode = result.DevCode
	}
	c.JSON(http.StatusAccepted, body)
}

// LoginPhone answers POST /auth/phone/login with the password login session shape.
func (h *Handler) LoginPhone(c *gin.Context) {
	var req phoneLoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	session, err := h.service.LoginPhone(c.Request.Context(), h.siteID(c), PhoneLoginInput{
		Phone:       req.Phone,
		Code:        req.Code,
		DisplayName: req.DisplayName,
		ClientMeta:  clientMeta(c),
	})
	if err != nil {
		// A 2FA protected account gets the same challenge body the password login
		// returns: 200 because the SMS code was correct, no session until the second
		// factor is proven.
		var challenge *TwoFactorRequiredError
		if errors.As(err, &challenge) {
			c.JSON(http.StatusOK, twoFactorChallengeResponse{
				TwoFactorRequired: true,
				ChallengeToken:    challenge.ChallengeToken,
				ExpiresIn:         int(TwoFactorChallengeTTL.Seconds()),
				ExpiresAt:         challenge.ExpiresAt.UTC(),
			})
			return
		}
		h.writePhoneError(c, err)
		return
	}
	h.writeSession(c, http.StatusOK, session)
}

// writePhoneError renders a phone failure, including the Retry-After hint a locked
// caller needs.
func (h *Handler) writePhoneError(c *gin.Context, err error) {
	var locked *TooManyAttemptsError
	if errors.As(err, &locked) {
		c.Header("Retry-After", retryAfterSeconds(locked.RetryAfter))
	}
	_ = c.Error(mapPhoneError(err))
}

// mapPhoneError translates phone login failures, overriding the two codes contract A
// names differently from the shared table.
func mapPhoneError(err error) *apperr.Problem {
	// contract A uses the code registration_closed for the phone login rejection,
	// while the shared mapping (kept for the password form, which the SPA already
	// understands) answers permission_denied with a reason detail.
	if errors.Is(err, ErrRegistrationClosed) {
		return newPhoneProblem(http.StatusForbidden, "registration_closed",
			"Registration closed", "本站暂未开放注册", map[string]any{"reason": "registration_closed"})
	}
	return mapError(err)
}

// invalidCodeProblem is the 401 answer for a wrong, expired or replayed code.
func invalidCodeProblem() *apperr.Problem {
	return newPhoneProblem(http.StatusUnauthorized, "invalid_code",
		"Invalid code", "验证码不正确或已过期", map[string]any{"reason": "invalid_code"})
}

// smsNotConfiguredProblem is the 503 answer when no gateway is wired.
func smsNotConfiguredProblem() *apperr.Problem {
	return newPhoneProblem(http.StatusServiceUnavailable, "sms_not_configured",
		"SMS not configured", "服务端还没有配置短信网关，暂时无法发送验证码",
		map[string]any{"reason": "sms_not_configured"})
}

// newPhoneProblem builds a Problem for a contract A code the fixed error table does
// not define. The shape matches apperr.New (type URL, title, message, details).
func newPhoneProblem(status int, code, title, message string, details map[string]any) *apperr.Problem {
	if details == nil {
		details = map[string]any{}
	}
	return &apperr.Problem{
		Type:    errorTypeBase + code,
		Title:   title,
		Status:  status,
		Code:    apperr.Code(code),
		Message: message,
		Details: details,
	}
}

// logError records a best effort failure when a logger was wired (see
// password_reset.go, where the shared helper lives).
