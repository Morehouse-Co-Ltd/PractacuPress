package auth_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/platform/config"
	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/platform/sms"

	entuseridentity "github.com/practacu/practacu-press/ent/useridentity"
)

// Phone code login tests (contract A).
//
// They run against the real Ent store on SQLite, because half of the contract is
// persistence behaviour (single use, attempts, hourly windows, hashed columns) that a
// fake repository would only re-assert. The transport is a bare gin engine with the
// same error writer the API uses, so the tests do not depend on the router package.

const testPhone = "13800138000"
const otherPhone = "13900139000"

// fakeSMSSender records delivered codes and can be made to fail.
type fakeSMSSender struct {
	mu   sync.Mutex
	sent []sms.Message
	err  error
}

func (f *fakeSMSSender) Send(_ context.Context, msg sms.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, msg)
	return nil
}

func (f *fakeSMSSender) Configured() bool { return true }

func (f *fakeSMSSender) last(t *testing.T) sms.Message {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(t, f.sent, "no SMS was sent")
	return f.sent[len(f.sent)-1]
}

func (f *fakeSMSSender) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

var _ sms.Sender = (*fakeSMSSender)(nil)

type phoneHarnessOptions struct {
	// registrationOpen, when set, is what the injected RegistrationPolicy answers; the
	// site row follows the same value.
	registrationOpen *bool
	devMode          bool
	ttl              time.Duration
	// withoutSMS builds the "provider off" deployment.
	withoutSMS bool
	// withoutPhoneCodes omits the explicit port; the service must then adopt the
	// authstore through Repository (the server's wiring).
	withoutPhoneCodes bool
	senderErr         error
}

type phoneHarness struct {
	engine  *gin.Engine
	db      *db.DB
	service *auth.Service
	siteID  string
	sender  *fakeSMSSender
	clock   *testClock
}

func newPhoneHarness(t *testing.T, opts phoneHarnessOptions) *phoneHarness {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "phone.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteBuilder := handle.Client.Site.Create().SetSlug("main").SetName("Main")
	if opts.registrationOpen != nil {
		siteBuilder.SetRegistrationOpen(*opts.registrationOpen)
	}
	siteRow, err := siteBuilder.Save(ctx)
	require.NoError(t, err)

	cfg := config.Config{
		AppEnv:        config.EnvTest,
		AuthJWTIssuer: "test-issuer",
		DefaultSiteID: siteRow.ID,
	}
	issuer, _, err := auth.NewTokenIssuer(cfg)
	require.NoError(t, err)

	clock := newTestClock(time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC))
	store := authstore.New(handle.Client)
	sender := &fakeSMSSender{err: opts.senderErr}

	serviceCfg := auth.ServiceConfig{
		Repository: store,
		Hasher: auth.NewArgon2idHasher(auth.Argon2Params{
			Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32,
		}),
		Tokens:     issuer,
		Now:        clock.Now,
		SMSDevMode: opts.devMode,
		SMSCodeTTL: opts.ttl,
	}
	if !opts.withoutPhoneCodes {
		serviceCfg.PhoneCodes = store
	}
	if !opts.withoutSMS {
		serviceCfg.SMS = sender
		serviceCfg.SMSProvider = sms.ProviderLog
	}
	if opts.registrationOpen != nil {
		open := *opts.registrationOpen
		serviceCfg.RegistrationPolicy = func(context.Context, string) (bool, error) {
			return open, nil
		}
	}

	service, err := auth.NewService(serviceCfg)
	require.NoError(t, err)

	handler := auth.NewHandler(service, auth.HandlerConfig{
		SiteID: func(*gin.Context) string { return siteRow.ID },
	})
	engine := gin.New()
	engine.Use(phoneProblemWriter())
	v1 := engine.Group("/api/v1")
	handler.PhoneRoutes(v1)
	// The second step of a 2FA protected phone login is the existing password login
	// endpoint, so the rest of the auth surface is mounted too: the test has to prove
	// the challenge is redeemable by the real handler, not by a stand-in.
	handler.Routes(v1, func(c *gin.Context) { c.Next() })

	return &phoneHarness{
		engine:  engine,
		db:      handle,
		service: service,
		siteID:  siteRow.ID,
		sender:  sender,
		clock:   clock,
	}
}

// phoneProblemWriter renders c.Error values the way the API middleware does, so a
// test sees the same status/code/details a browser would.
func phoneProblemWriter() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if len(c.Errors) == 0 {
			return
		}
		problem := apperr.FromError(c.Errors.Last().Err)
		c.Header("Content-Type", apperr.ContentType)
		c.JSON(problem.Status, problem)
	}
}

func (h *phoneHarness) do(t *testing.T, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.engine.ServeHTTP(w, req)
	return w
}

func (h *phoneHarness) requestCode(t *testing.T, phone string) *httptest.ResponseRecorder {
	t.Helper()
	return h.requestCodeWithPurpose(t, phone, "login")
}

func (h *phoneHarness) requestCodeWithPurpose(
	t *testing.T,
	phone, purpose string,
) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/phone/codes",
		jsonBody(t, map[string]string{"phone": phone, "purpose": purpose}))
	req.Header.Set("Content-Type", "application/json")
	return h.do(t, req)
}

func (h *phoneHarness) login(t *testing.T, phone, code, displayName string) *httptest.ResponseRecorder {
	t.Helper()
	payload := map[string]string{"phone": phone, "code": code}
	if displayName != "" {
		payload["display_name"] = displayName
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/phone/login", jsonBody(t, payload))
	req.Header.Set("Content-Type", "application/json")
	return h.do(t, req)
}

func (h *phoneHarness) requestAndReadCode(t *testing.T, phone string) string {
	t.Helper()
	w := h.requestCode(t, phone)
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	return h.sender.last(t).Code
}

// problemCode returns the machine readable code of a Problem response.
func problemCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	payload := decode(t, w)
	code, _ := payload["code"].(string)
	return code
}

func openRegistration() *bool {
	open := true
	return &open
}

func closedRegistration() *bool {
	closed := false
	return &closed
}

// --- normalization ----------------------------------------------------------

func TestNormalizePhone(t *testing.T) {
	cases := map[string]string{
		"13800138000":       "13800138000",
		" 138 0013 8000 ":   "13800138000",
		"138-0013-8000":     "13800138000",
		"+8613800138000":    "+8613800138000",
		"+86 138 0013 8000": "+8613800138000",
		"(138)0013-8000":    "13800138000",
	}
	for raw, want := range cases {
		got, err := auth.NormalizePhone(raw)
		require.NoError(t, err, "input %q", raw)
		require.Equal(t, want, got, "input %q", raw)
	}

	for _, raw := range []string{
		"",
		"   ",
		"12345",
		"23800138000",
		"1380013800a",
		"+0123456789",
		"+1234567",          // too short for E.164
		"+1234567890123456", // too long for E.164
	} {
		_, err := auth.NormalizePhone(raw)
		require.Error(t, err, "input %q must be refused", raw)
		require.ErrorIs(t, err, auth.ErrInvalidInput)
	}
}

func TestPhoneMasked(t *testing.T) {
	require.Equal(t, "138****8000", auth.PhoneMasked("13800138000"))
	require.Equal(t, "+861****8000", auth.PhoneMasked("+8613800138000"))
	require.NotContains(t, auth.PhoneMasked("13800138000"), "0013")
	require.Equal(t, "****", auth.PhoneMasked("1234"))
}

func TestPhoneHashIncludesSite(t *testing.T) {
	require.NotEqual(t,
		auth.PhoneHash("site-a", testPhone),
		auth.PhoneHash("site-b", testPhone),
		"the same number on two sites must not share a lookup key",
	)
	require.NotContains(t, auth.PhoneHash("site-a", testPhone), testPhone)
}

// --- policy -----------------------------------------------------------------

func TestPhonePolicyReportsGatewayAndRegistration(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/phone/policy", nil)
	w := h.do(t, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	payload := decode(t, w)
	require.Equal(t, true, payload["enabled"])
	require.Equal(t, sms.ProviderLog, payload["provider"])
	require.Equal(t, true, payload["registration_open"])
}

func TestPhonePolicyReportsClosedRegistration(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: closedRegistration()})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/phone/policy", nil)
	w := h.do(t, req)
	require.Equal(t, http.StatusOK, w.Code)

	payload := decode(t, w)
	require.Equal(t, false, payload["registration_open"])
}

func TestPhoneEndpointsReportMissingGateway(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{withoutSMS: true})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/phone/policy", nil)
	w := h.do(t, req)
	require.Equal(t, http.StatusOK, w.Code)
	payload := decode(t, w)
	require.Equal(t, false, payload["enabled"])
	require.Equal(t, sms.ProviderOff, payload["provider"])

	codes := h.requestCode(t, testPhone)
	require.Equal(t, http.StatusServiceUnavailable, codes.Code)
	require.Equal(t, "sms_not_configured", problemCode(t, codes))

	login := h.login(t, testPhone, "123456", "")
	require.Equal(t, http.StatusServiceUnavailable, login.Code)
	require.Equal(t, "sms_not_configured", problemCode(t, login))
}

// TestPhoneStoreFallsBackToRepository pins the server's wiring convenience: one
// authstore backs both Repository and the phone port, so the service adopts it when
// PhoneCodes is omitted. Without the fallback a forgotten field would silently
// answer sms_not_configured on a fully configured deployment.
func TestPhoneStoreFallsBackToRepository(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{
		registrationOpen:  openRegistration(),
		withoutPhoneCodes: true,
	})

	w := h.requestCode(t, testPhone)
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())

	login := h.login(t, testPhone, h.sender.last(t).Code, "Alice")
	require.Equal(t, http.StatusOK, login.Code, login.Body.String())
}

// --- code request -----------------------------------------------------------

func TestRequestPhoneCodeStoresHashesAndSends(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	w := h.requestCodeWithPurpose(t, testPhone, "register")
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())

	payload := decode(t, w)
	expiresAt, err := time.Parse(time.RFC3339, payload["expires_at"].(string))
	require.NoError(t, err)
	require.True(t, expiresAt.After(h.clock.Now()), "the code must expire in the future")
	require.EqualValues(t, 60, payload["resend_after_seconds"])
	require.NotContains(t, payload, "dev_code", "the code must not leak without SMS_DEV_MODE")

	sent := h.sender.last(t)
	require.Equal(t, testPhone, sent.Phone)
	require.Equal(t, "register", sent.Purpose)
	require.Len(t, sent.Code, 6)
	require.Equal(t, auth.DefaultPhoneCodeTTL, sent.TTL)

	rows, err := h.db.Client.PhoneCode.Query().All(context.Background())
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, auth.PhoneHash(h.siteID, testPhone), rows[0].PhoneHash)
	require.Equal(t, auth.PhoneMasked(testPhone), rows[0].PhoneMasked)
	require.NotEqual(t, sent.Code, rows[0].CodeHash)
	require.NotEmpty(t, rows[0].RequestIPHash, "the source address is stored hashed")
	require.NotContains(t, rows[0].RequestIPHash, "192.0.2.1")
	require.Nil(t, rows[0].ConsumedAt)
}

func TestRequestPhoneCodeDevModeReturnsCode(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{devMode: true, registrationOpen: openRegistration()})

	w := h.requestCode(t, testPhone)
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())

	payload := decode(t, w)
	require.Equal(t, auth.DevPhoneCode, payload["dev_code"])

	login := h.login(t, testPhone, auth.DevPhoneCode, "Alice")
	require.Equal(t, http.StatusOK, login.Code, login.Body.String())
}

func TestRequestPhoneCodeRejectsMalformedPhone(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	w := h.requestCode(t, "not-a-phone")
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Zero(t, h.sender.count(), "a malformed number must not reach the gateway")
}

func TestRequestPhoneCodeRejectsUnknownPurpose(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	w := h.requestCodeWithPurpose(t, testPhone, "reset")
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRequestPhoneCodeRateLimitPerPhone(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	for i := 0; i < auth.PhoneCodesPerPhonePerHour; i++ {
		w := h.requestCode(t, testPhone)
		require.Equal(t, http.StatusAccepted, w.Code, "request %d: %s", i+1, w.Body.String())
	}

	limited := h.requestCode(t, testPhone)
	require.Equal(t, http.StatusTooManyRequests, limited.Code)
	require.NotEmpty(t, limited.Header().Get("Retry-After"))
	require.Equal(t, auth.PhoneCodesPerPhonePerHour, h.sender.count(),
		"a refused request must not reach the gateway")
}

func TestRequestPhoneCodeRateLimitPerIP(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	// Distinct numbers spend one phone budget each, so only the IP window can refuse.
	for i := 0; i < auth.PhoneCodesPerIPPerHour; i++ {
		phone := fmt.Sprintf("1380013%04d", i)
		w := h.requestCode(t, phone)
		require.Equal(t, http.StatusAccepted, w.Code, "request %d: %s", i+1, w.Body.String())
	}

	limited := h.requestCode(t, "13700137000")
	require.Equal(t, http.StatusTooManyRequests, limited.Code)
	require.Equal(t, auth.PhoneCodesPerIPPerHour, h.sender.count())
}

func TestRequestPhoneCodeDeliveryFailureIsReported(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{
		registrationOpen: openRegistration(),
		senderErr:        errors.New("gateway down"),
	})

	w := h.requestCode(t, testPhone)
	require.GreaterOrEqual(t, w.Code, 500)
	require.Zero(t, h.sender.count())
}

// --- login ------------------------------------------------------------------

func TestPhoneLoginCreatesMemberAndSession(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})
	ctx := context.Background()

	code := h.requestAndReadCode(t, testPhone)
	w := h.login(t, testPhone, code, "Alice")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	payload := decode(t, w)
	require.Equal(t, "Bearer", payload["token_type"])
	require.NotEmpty(t, payload["access_token"])
	require.NotEmpty(t, payload["csrf_token"])
	require.NotContains(t, payload, "dev_code")
	user, ok := payload["user"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "Alice", user["display_name"])
	userID, ok := user["id"].(string)
	require.True(t, ok)

	require.NotEmpty(t, cookieValue(w, auth.RefreshCookieName), "login must set the refresh cookie")
	require.NotEmpty(t, cookieValue(w, auth.CSRFCookieName))

	// The account, its phone identity and the membership exist.
	account, err := h.db.Client.User.Get(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, "Alice", account.DisplayName)
	identities, err := h.db.Client.UserIdentity.Query().
		Where(entuseridentity.ProviderEQ("phone")).
		All(ctx)
	require.NoError(t, err)
	require.Len(t, identities, 1)
	require.Equal(t, userID, identities[0].UserID)
	require.NotNil(t, identities[0].Phone, "the phone mirror column is written")
	members, err := h.db.Client.SiteMember.Query().All(ctx)
	require.NoError(t, err)
	require.Len(t, members, 1)
	require.Equal(t, "member", members[0].Role)

	// The code is single use.
	rows, err := h.db.Client.PhoneCode.Query().All(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.NotNil(t, rows[0].ConsumedAt)

	// A second sign-in resolves the same account.
	secondCode := h.requestAndReadCode(t, testPhone)
	second := h.login(t, testPhone, secondCode, "")
	require.Equal(t, http.StatusOK, second.Code, second.Body.String())
	secondPayload := decode(t, second)
	secondUser := secondPayload["user"].(map[string]any)
	require.Equal(t, userID, secondUser["id"], "the identity must win over creating a second account")
}

func TestPhoneLoginRejectsWrongCodeAndRetiresAfterFiveAttempts(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	code := h.requestAndReadCode(t, testPhone)
	wrong := "000000"
	if code == wrong {
		wrong = "111111"
	}

	for attempt := 1; attempt <= auth.MaxPhoneCodeAttempts; attempt++ {
		w := h.login(t, testPhone, wrong, "")
		if attempt < auth.MaxPhoneCodeAttempts {
			require.Equal(t, http.StatusUnauthorized, w.Code, "attempt %d", attempt)
			require.Equal(t, "invalid_code", problemCode(t, w))
		} else {
			require.Equal(t, http.StatusTooManyRequests, w.Code, "the fifth guess retires the code")
		}
	}

	// The correct code no longer works: the row was retired.
	retired := h.login(t, testPhone, code, "")
	require.Equal(t, http.StatusUnauthorized, retired.Code)
	require.Equal(t, "invalid_code", problemCode(t, retired))
}

func TestPhoneLoginRejectsExpiredCode(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{
		registrationOpen: openRegistration(),
		ttl:              5 * time.Minute,
	})

	code := h.requestAndReadCode(t, testPhone)
	h.clock.Advance(6 * time.Minute)

	w := h.login(t, testPhone, code, "")
	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, "invalid_code", problemCode(t, w))
}

func TestPhoneLoginRejectsReplayedCode(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	code := h.requestAndReadCode(t, testPhone)
	first := h.login(t, testPhone, code, "Alice")
	require.Equal(t, http.StatusOK, first.Code, first.Body.String())

	replay := h.login(t, testPhone, code, "Alice")
	require.Equal(t, http.StatusUnauthorized, replay.Code)
	require.Equal(t, "invalid_code", problemCode(t, replay))
}

func TestPhoneLoginRejectsMalformedCode(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	w := h.login(t, testPhone, "abc", "")
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestPhoneLoginRespectsClosedRegistration(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: closedRegistration()})

	// Requesting a code is not gated; only creating an account is.
	w := h.requestCode(t, testPhone)
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	code := h.sender.last(t).Code

	login := h.login(t, testPhone, code, "")
	require.Equal(t, http.StatusForbidden, login.Code)
	require.Equal(t, "registration_closed", problemCode(t, login))

	users, err := h.db.Client.User.Query().Count(context.Background())
	require.NoError(t, err)
	require.Zero(t, users, "a closed site must not leave an account behind")
}

// TestPhoneLoginStoreEnforcesRegistrationSwitch proves the persistence layer also
// refuses, not only the injected policy: the row level switch is the last line.
func TestPhoneLoginStoreEnforcesRegistrationSwitch(t *testing.T) {
	// No RegistrationPolicy is injected, so only the site row decides.
	h := newPhoneHarness(t, phoneHarnessOptions{})

	_, err := h.db.Client.Site.UpdateOneID(h.siteID).SetRegistrationOpen(false).Save(context.Background())
	require.NoError(t, err)

	code := h.requestAndReadCode(t, testPhone)
	login := h.login(t, testPhone, code, "")
	require.Equal(t, http.StatusForbidden, login.Code)
	require.Equal(t, "registration_closed", problemCode(t, login))
}

func TestPhoneLoginRequiresExistingCode(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	w := h.login(t, testPhone, "123456", "")
	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, "invalid_code", problemCode(t, w))
}

// --- two-factor parity ------------------------------------------------------

// bindPhoneIdentity binds a phone login method to an existing account.
//
// The harness store is built without a field cipher, so the identity columns are
// stored as supplied; that is exactly what the phone lookup reads back.
func (h *phoneHarness) bindPhoneIdentity(t *testing.T, userID, phone string) {
	t.Helper()
	_, err := h.db.Client.UserIdentity.Create().
		SetUserID(userID).
		SetProvider("phone").
		SetProviderSubject(phone).
		SetPhone(phone).
		SetVerifiedAt(h.clock.Now()).
		Save(context.Background())
	require.NoError(t, err)
}

// createPasswordAccountWithPhone registers a password account and binds the phone to
// it, which is how an existing member with 2FA ends up signing in by SMS.
func (h *phoneHarness) createPasswordAccountWithPhone(t *testing.T, phone string) string {
	t.Helper()
	session, err := h.service.RegisterEmail(context.Background(), h.siteID, auth.RegisterEmailInput{
		Email:       "2fa@example.com",
		Password:    twoFactorTestPassword,
		DisplayName: "TwoFactor",
	})
	require.NoError(t, err)
	h.bindPhoneIdentity(t, session.User.ID, phone)
	return session.User.ID
}

// twoFactorTestPassword satisfies the password policy.
const twoFactorTestPassword = "correct horse battery"

// enableTwoFactor enrolls and confirms a TOTP authenticator for an account.
func (h *phoneHarness) enableTwoFactor(t *testing.T, userID string) string {
	t.Helper()
	ctx := context.Background()
	enrollment, err := h.service.BeginTwoFactorEnrollment(ctx, userID, h.siteID, twoFactorTestPassword)
	require.NoError(t, err)
	_, err = h.service.ConfirmTwoFactor(ctx, userID, h.siteID,
		totpCodeAt(t, enrollment.Secret, h.clock.Now()))
	require.NoError(t, err)
	return enrollment.Secret
}

// totpCodeAt computes the RFC 6238 code of the time step containing at.
//
// The package helper is unexported, and re-implementing the 20 lines of HMAC here is
// what keeps the test able to drive a real authenticator code.
func totpCodeAt(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	encoding := base32.StdEncoding.WithPadding(base32.NoPadding)
	key, err := encoding.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	require.NoError(t, err)

	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(at.Unix()/30))
	mac := hmac.New(sha1.New, key)
	_, err = mac.Write(counter[:])
	require.NoError(t, err)
	sum := mac.Sum(nil)

	offset := sum[len(sum)-1] & 0x0f
	binaryCode := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])
	return fmt.Sprintf("%06d", binaryCode%1_000_000)
}

// TestPhoneLoginRaisesTwoFactorChallenge is the security fix: a correct SMS code for
// an account with an active authenticator yields the password login's challenge, not a
// session, and the existing second step completes the login.
func TestPhoneLoginRaisesTwoFactorChallenge(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	userID := h.createPasswordAccountWithPhone(t, testPhone)
	secret := h.enableTwoFactor(t, userID)

	code := h.requestAndReadCode(t, testPhone)
	w := h.login(t, testPhone, code, "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	payload := decode(t, w)
	require.Equal(t, true, payload["two_factor_required"])
	challengeToken, ok := payload["challenge_token"].(string)
	require.True(t, ok)
	require.NotEmpty(t, challengeToken)
	require.EqualValues(t, int(auth.TwoFactorChallengeTTL.Seconds()), payload["expires_in"])
	require.NotContains(t, payload, "access_token", "no session before the second factor")
	require.NotContains(t, payload, "csrf_token")
	require.Empty(t, cookieValue(w, auth.RefreshCookieName), "no refresh cookie before the second factor")

	// The same POST /auth/login/2fa the password flow uses completes the login.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/2fa", jsonBody(t, map[string]string{
		"challenge_token": challengeToken,
		"code":            totpCodeAt(t, secret, h.clock.Now()),
	}))
	req.Header.Set("Content-Type", "application/json")
	second := h.do(t, req)
	require.Equal(t, http.StatusOK, second.Code, second.Body.String())

	secondPayload := decode(t, second)
	require.NotEmpty(t, secondPayload["access_token"], "the second factor issues the session")
	require.NotEmpty(t, cookieValue(second, auth.RefreshCookieName))
	secondUser, ok := secondPayload["user"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, userID, secondUser["id"])
}

// TestPhoneLoginWithoutTwoFactorIssuesSessionDirectly is the negative half: an account
// with no authenticator keeps the contract A "session like password login" answer.
func TestPhoneLoginWithoutTwoFactorIssuesSessionDirectly(t *testing.T) {
	h := newPhoneHarness(t, phoneHarnessOptions{registrationOpen: openRegistration()})

	code := h.requestAndReadCode(t, testPhone)
	w := h.login(t, testPhone, code, "Alice")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	payload := decode(t, w)
	require.NotContains(t, payload, "two_factor_required")
	require.NotEmpty(t, payload["access_token"])
	require.NotEmpty(t, cookieValue(w, auth.RefreshCookieName))
	require.NotEmpty(t, cookieValue(w, auth.CSRFCookieName))
}
