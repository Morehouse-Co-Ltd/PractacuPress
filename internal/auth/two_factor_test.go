package auth_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// totpFor is an independent RFC 6238 implementation used by the tests.
//
// It deliberately does not call the unexported production helper: a test that
// reuses the code under test would pass even if both were wrong.
func totpFor(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).
		DecodeString(strings.ToUpper(strings.TrimRight(secret, "=")))
	require.NoError(t, err)

	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(at.Unix()/30))
	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])
	return fmt.Sprintf("%06d", code%1_000_000)
}

func authedJSON(t *testing.T, h *apiHarness, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		bearer(req, token)
	}
	return h.do(t, req)
}

func passwordLogin(t *testing.T, h *apiHarness, email, password string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password",
		jsonBody(t, map[string]string{"email": email, "password": password}))
	req.Header.Set("Content-Type", "application/json")
	return h.do(t, req)
}

// enableTwoFactor walks the public enrollment flow and returns the secret and the
// one time recovery codes.
func enableTwoFactor(t *testing.T, h *apiHarness, token, password string, at time.Time) (string, []string) {
	t.Helper()
	enroll := authedJSON(t, h, http.MethodPost, "/api/v1/me/2fa/enroll", token,
		fmt.Sprintf(`{"password":%q}`, password))
	require.Equal(t, http.StatusOK, enroll.Code)
	enrolled := decode(t, enroll)
	secret, _ := enrolled["secret"].(string)
	require.NotEmpty(t, secret)
	require.Contains(t, enrolled["otpauth_uri"], "otpauth://totp/")
	require.Equal(t, enrolled["otpauth_uri"], enrolled["qr_content"])

	confirm := authedJSON(t, h, http.MethodPost, "/api/v1/me/2fa/confirm", token,
		fmt.Sprintf(`{"code":%q}`, totpFor(t, secret, at)))
	require.Equal(t, http.StatusOK, confirm.Code, confirm.Body.String())
	raw, ok := decode(t, confirm)["recovery_codes"].([]any)
	require.True(t, ok)
	require.Len(t, raw, 10)

	codes := make([]string, 0, len(raw))
	for _, item := range raw {
		codes = append(codes, item.(string))
	}
	return secret, codes
}

// testTwoFactorClock starts at an aligned wall clock instant: the JWT issuer uses
// the real clock, so a challenge minted for a far future or past instant would be
// rejected as not yet valid / expired before the service ever sees it.
func testTwoFactorClock() *testClock {
	return newTestClock(time.Now().UTC().Truncate(30 * time.Second))
}

func TestTwoFactorEndToEnd(t *testing.T) {
	clock := testTwoFactorClock()
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{now: clock.Now})

	session := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, session.Code)
	token := sessionToken(t, session)

	// No enrollment yet: the status endpoint answers disabled and the login flow is
	// unchanged (single factor).
	status := authedJSON(t, h, http.MethodGet, "/api/v1/me/2fa", token, "")
	require.Equal(t, http.StatusOK, status.Code)
	require.False(t, decode(t, status)["enabled"].(bool))
	require.Equal(t, http.StatusOK, passwordLogin(t, h, "alice@example.com", "correct horse battery").Code)

	// Enrolling requires the password, so a hijacked session cannot bind its own app.
	require.Equal(t, http.StatusBadRequest, authedJSON(t, h, http.MethodPost,
		"/api/v1/me/2fa/enroll", token, `{"password":"wrong password"}`).Code)

	secret, codes := enableTwoFactor(t, h, token, "correct horse battery", clock.Now())

	status = authedJSON(t, h, http.MethodGet, "/api/v1/me/2fa", token, "")
	require.True(t, decode(t, status)["enabled"].(bool))
	require.EqualValues(t, 10, decode(t, status)["recovery_codes_remaining"])

	// A password login now issues a challenge, not a session, and no cookies.
	challengeResponse := passwordLogin(t, h, "alice@example.com", "correct horse battery")
	require.Equal(t, http.StatusOK, challengeResponse.Code)
	challenge := decode(t, challengeResponse)
	require.True(t, challenge["two_factor_required"].(bool))
	require.Empty(t, challenge["access_token"])
	require.False(t, sessionCookieIssued(challengeResponse), "a 2FA login must not set session cookies")
	challengeToken, _ := challenge["challenge_token"].(string)
	require.NotEmpty(t, challengeToken)

	// A wrong code is rejected and does not burn the challenge.
	code := totpFor(t, secret, clock.Now())
	bad := authedJSON(t, h, http.MethodPost, "/api/v1/auth/login/2fa", "",
		fmt.Sprintf(`{"challenge_token":%q,"code":"000000"}`, challengeToken))
	require.Equal(t, http.StatusBadRequest, bad.Code)
	require.Equal(t, "invalid_two_factor_code", problemReason(t, bad))

	verify := authedJSON(t, h, http.MethodPost, "/api/v1/auth/login/2fa", "",
		fmt.Sprintf(`{"challenge_token":%q,"code":%q}`, challengeToken, code))
	require.Equal(t, http.StatusOK, verify.Code)
	require.NotEmpty(t, sessionToken(t, verify))
	// Replaying the same time step is rejected: one 30 second code is single use.
	secondChallenge := passwordLogin(t, h, "alice@example.com", "correct horse battery")
	secondToken, _ := decode(t, secondChallenge)["challenge_token"].(string)
	require.NotEmpty(t, secondToken)
	replay := authedJSON(t, h, http.MethodPost, "/api/v1/auth/login/2fa", "",
		fmt.Sprintf(`{"challenge_token":%q,"code":%q}`, secondToken, code))
	require.Equal(t, http.StatusBadRequest, replay.Code)
	require.Equal(t, "two_factor_code_already_used", problemReason(t, replay))

	// A challenge is single use: the one that already produced a session is dead.
	reuse := authedJSON(t, h, http.MethodPost, "/api/v1/auth/login/2fa", "",
		fmt.Sprintf(`{"challenge_token":%q,"code":%q}`, challengeToken, code))
	require.Equal(t, http.StatusUnauthorized, reuse.Code)

	// A recovery code works once and only once, and is accepted instead of a TOTP code.
	clock.Advance(30 * time.Second)
	recoveryChallenge := passwordLogin(t, h, "alice@example.com", "correct horse battery")
	recoveryToken, _ := decode(t, recoveryChallenge)["challenge_token"].(string)
	recovery := authedJSON(t, h, http.MethodPost, "/api/v1/auth/login/2fa", "",
		fmt.Sprintf(`{"challenge_token":%q,"code":%q}`, recoveryToken, codes[0]))
	require.Equal(t, http.StatusOK, recovery.Code, recovery.Body.String())

	recoveryAgain := passwordLogin(t, h, "alice@example.com", "correct horse battery")
	recoveryAgainToken, _ := decode(t, recoveryAgain)["challenge_token"].(string)
	burned := authedJSON(t, h, http.MethodPost, "/api/v1/auth/login/2fa", "",
		fmt.Sprintf(`{"challenge_token":%q,"code":%q}`, recoveryAgainToken, codes[0]))
	require.Equal(t, http.StatusBadRequest, burned.Code)

	status = authedJSON(t, h, http.MethodGet, "/api/v1/me/2fa", token, "")
	require.EqualValues(t, 9, decode(t, status)["recovery_codes_remaining"])

	// Regenerating the codes needs the password plus a working factor.
	clock.Advance(30 * time.Second)
	regenerated := authedJSON(t, h, http.MethodPost, "/api/v1/me/2fa/recovery-codes", token,
		fmt.Sprintf(`{"password":"correct horse battery","code":%q}`, totpFor(t, secret, clock.Now())))
	require.Equal(t, http.StatusOK, regenerated.Code, regenerated.Body.String())
	require.Len(t, decode(t, regenerated)["recovery_codes"].([]any), 10)

	// Disabling needs both factors; wrong password leaves TOTP on.
	require.Equal(t, http.StatusBadRequest, authedJSON(t, h, http.MethodPost,
		"/api/v1/me/2fa/disable", token,
		fmt.Sprintf(`{"password":"nope","code":%q}`, totpFor(t, secret, clock.Now().Add(30*time.Second)))).Code)

	clock.Advance(30 * time.Second)
	disabled := authedJSON(t, h, http.MethodPost, "/api/v1/me/2fa/disable", token,
		fmt.Sprintf(`{"password":"correct horse battery","code":%q}`, totpFor(t, secret, clock.Now())))
	require.Equal(t, http.StatusNoContent, disabled.Code, disabled.Body.String())

	status = authedJSON(t, h, http.MethodGet, "/api/v1/me/2fa", token, "")
	require.False(t, decode(t, status)["enabled"].(bool))

	// Back to single factor: the password alone starts a session again.
	plain := passwordLogin(t, h, "alice@example.com", "correct horse battery")
	require.Equal(t, http.StatusOK, plain.Code)
	require.NotEmpty(t, sessionToken(t, plain))
}

func TestTwoFactorChallengeCannotBeUsedAsAnAccessToken(t *testing.T) {
	clock := testTwoFactorClock()
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{now: clock.Now})
	registered := register(t, h, "alice@example.com")
	token := sessionToken(t, registered)
	_, _ = enableTwoFactor(t, h, token, "correct horse battery", clock.Now())

	challenge := decode(t, passwordLogin(t, h, "alice@example.com", "correct horse battery"))
	challengeToken, _ := challenge["challenge_token"].(string)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	bearer(req, challengeToken)
	require.Equal(t, http.StatusUnauthorized, h.do(t, req).Code)
}

func TestTwoFactorVerifyLocksOutAfterRepeatedFailures(t *testing.T) {
	clock := testTwoFactorClock()
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{now: clock.Now})
	registered := register(t, h, "alice@example.com")
	token := sessionToken(t, registered)
	_, _ = enableTwoFactor(t, h, token, "correct horse battery", clock.Now())

	challengeToken := ""
	for attempt := 0; attempt < 5; attempt++ {
		challenge := decode(t, passwordLogin(t, h, "alice@example.com", "correct horse battery"))
		challengeToken, _ = challenge["challenge_token"].(string)
		require.NotEmpty(t, challengeToken)
		w := authedJSON(t, h, http.MethodPost, "/api/v1/auth/login/2fa", "",
			fmt.Sprintf(`{"challenge_token":%q,"code":"000000"}`, challengeToken))
		require.Equal(t, http.StatusBadRequest, w.Code)
	}

	challenge := decode(t, passwordLogin(t, h, "alice@example.com", "correct horse battery"))
	challengeToken, _ = challenge["challenge_token"].(string)
	locked := authedJSON(t, h, http.MethodPost, "/api/v1/auth/login/2fa", "",
		fmt.Sprintf(`{"challenge_token":%q,"code":"000000"}`, challengeToken))
	require.Equal(t, http.StatusTooManyRequests, locked.Code)
	require.NotEmpty(t, locked.Header().Get("Retry-After"))
}

func TestPlatformAdminResetsMemberTwoFactor(t *testing.T) {
	clock := testTwoFactorClock()
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{
		now:                 clock.Now,
		bootstrapFirstAdmin: true,
		firstAdminAllowed:   func(*gin.Context) bool { return true },
	})

	admin := register(t, h, "admin@example.com")
	require.Equal(t, http.StatusCreated, admin.Code)
	adminToken := sessionToken(t, admin)
	adminID := decode(t, admin)["user"].(map[string]any)["id"].(string)

	member := register(t, h, "bob@example.com")
	require.Equal(t, http.StatusCreated, member.Code)
	memberToken := sessionToken(t, member)
	memberPayload := decode(t, member)
	memberID := memberPayload["user"].(map[string]any)["id"].(string)

	_, _ = enableTwoFactor(t, h, memberToken, "correct horse battery", clock.Now())

	// A plain member cannot reset anyone, including itself as an escalation step.
	require.Equal(t, http.StatusForbidden, authedJSON(t, h, http.MethodPost,
		fmt.Sprintf("/api/v1/sites/%s/members/%s/2fa/reset", h.siteID, memberID),
		memberToken, `{}`).Code)

	// Even a platform administrator cannot strip its own second factor here.
	require.Equal(t, http.StatusForbidden, authedJSON(t, h, http.MethodPost,
		fmt.Sprintf("/api/v1/sites/%s/members/%s/2fa/reset", h.siteID, adminID),
		adminToken, `{}`).Code)

	reset := authedJSON(t, h, http.MethodPost,
		fmt.Sprintf("/api/v1/sites/%s/members/%s/2fa/reset", h.siteID, memberID),
		adminToken, `{}`)
	require.Equal(t, http.StatusNoContent, reset.Code, reset.Body.String())

	// The member is back to a single factor login.
	require.Equal(t, http.StatusOK, passwordLogin(t, h, "bob@example.com", "correct horse battery").Code)
}

func TestTwoFactorStoredSecretIsSealed(t *testing.T) {
	clock := testTwoFactorClock()
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{now: clock.Now})
	registered := register(t, h, "alice@example.com")
	token := sessionToken(t, registered)
	secret, _ := enableTwoFactor(t, h, token, "correct horse battery", clock.Now())

	row, err := h.db.Client.TwoFactor.Query().First(t.Context())
	require.NoError(t, err)
	require.NotEqual(t, secret, row.Secret, "the TOTP secret must not be stored in plaintext")
	require.True(t, strings.HasPrefix(row.Secret, "v1:"), "the secret must use the sealed envelope")
	require.NotContains(t, row.Secret, secret)
}
