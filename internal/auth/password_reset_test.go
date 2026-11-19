package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/mailer"
)

// recordingMailer keeps every message so a test can pull the reset link out of it.
type recordingMailer struct {
	mu   sync.Mutex
	sent []mailer.Message
	err  error
}

func (m *recordingMailer) Send(_ context.Context, msg mailer.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return m.err
	}
	m.sent = append(m.sent, msg)
	return nil
}

func (m *recordingMailer) Configured() bool { return true }

func (m *recordingMailer) messages() []mailer.Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]mailer.Message(nil), m.sent...)
}

// resetMail returns the most recent password reset message.
//
// Registration now sends its own verification mail, so the reset link is not
// necessarily the first (or only) message in the inbox. Selecting by the reset
// path keeps these tests about password reset instead of about mail ordering.
func resetMail(t *testing.T, sender *recordingMailer) mailer.Message {
	t.Helper()
	messages := sender.messages()
	for index := len(messages) - 1; index >= 0; index-- {
		if strings.Contains(messages[index].Text, "/reset-password?token=") {
			return messages[index]
		}
	}
	t.Fatal("password reset mail is missing")
	return mailer.Message{}
}

func resetMailCount(sender *recordingMailer) int {
	count := 0
	for _, message := range sender.messages() {
		if strings.Contains(message.Text, "/reset-password?token=") {
			count++
		}
	}
	return count
}

// resetToken pulls the token query parameter out of the link in the plain text body.
func resetToken(t *testing.T, msg mailer.Message) string {
	t.Helper()
	index := strings.Index(msg.Text, "token=")
	require.GreaterOrEqual(t, index, 0, "reset link is missing from the message")
	raw := msg.Text[index+len("token="):]
	if end := strings.IndexAny(raw, " \r\n"); end >= 0 {
		raw = raw[:end]
	}
	token, err := url.QueryUnescape(raw)
	require.NoError(t, err)
	return token
}

func requestReset(t *testing.T, h *apiHarness, email string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/password-reset/request",
		jsonBody(t, map[string]string{"email": email}))
	req.Header.Set("Content-Type", "application/json")
	return h.do(t, req)
}

func confirmReset(t *testing.T, h *apiHarness, token, password string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/password-reset/confirm",
		jsonBody(t, map[string]string{"token": token, "password": password}))
	req.Header.Set("Content-Type", "application/json")
	return h.do(t, req)
}

func login(t *testing.T, h *apiHarness, email, password string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password",
		jsonBody(t, map[string]string{"email": email, "password": password}))
	req.Header.Set("Content-Type", "application/json")
	return h.do(t, req)
}

func TestPasswordResetPolicyWithoutMail(t *testing.T) {
	h := newAPIHarness(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/password-reset/policy", nil)
	w := h.do(t, req)

	require.Equal(t, http.StatusOK, w.Code)
	payload := decode(t, w)
	require.Equal(t, false, payload["enabled"])
	require.Equal(t, "email", payload["delivery"])

	// Without a relay the request must fail loudly instead of pretending to send.
	require.Equal(t, http.StatusServiceUnavailable, requestReset(t, h, "alice@example.com").Code)
}

func TestPasswordResetPolicyWithMail(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/password-reset/policy", nil)
	w := h.do(t, req)

	require.Equal(t, http.StatusOK, w.Code)
	payload := decode(t, w)
	require.Equal(t, true, payload["enabled"])
	require.Equal(t, float64(1800), payload["expires_in"])
}

// TestPasswordResetRoundTrip is the happy path: request, redeem, log in with the new
// password, and prove every old session is gone.
func TestPasswordResetRoundTrip(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	w := requestReset(t, h, "alice@example.com")
	require.Equal(t, http.StatusAccepted, w.Code)
	payload := decode(t, w)
	require.Equal(t, "accepted", payload["status"])

	messages := sender.messages()
	require.Len(t, messages, 2, "registration verification plus the reset link")
	reset := resetMail(t, sender)
	require.Equal(t, []string{"alice@example.com"}, reset.To)
	require.Contains(t, reset.Text, "/reset-password?token=")

	token := resetToken(t, reset)
	require.NotEmpty(t, token)

	require.Equal(t, http.StatusNoContent,
		confirmReset(t, h, token, "a brand new passphrase").Code)

	// The new password works and the old one does not.
	require.Equal(t, http.StatusOK, login(t, h, "alice@example.com", "a brand new passphrase").Code)
	require.Equal(t, http.StatusUnauthorized, login(t, h, "alice@example.com", "correct horse battery").Code)
}

func TestPasswordResetTokenIsSingleUse(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)
	require.Equal(t, http.StatusAccepted, requestReset(t, h, "alice@example.com").Code)

	token := resetToken(t, resetMail(t, sender))
	require.Equal(t, http.StatusNoContent, confirmReset(t, h, token, "first new password").Code)

	replay := confirmReset(t, h, token, "second new password")
	require.Equal(t, http.StatusBadRequest, replay.Code)
	require.Equal(t, "reset_token_invalid", decode(t, replay)["details"].(map[string]any)["reason"])
}

func TestPasswordResetRejectsShortPassword(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)
	require.Equal(t, http.StatusAccepted, requestReset(t, h, "alice@example.com").Code)

	token := resetToken(t, resetMail(t, sender))
	w := confirmReset(t, h, token, "Aa1!Aa1!Aa1") // 11 runes
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, "validation_failed", decode(t, w)["code"])

	// A rejected password must not burn the link.
	require.Equal(t, http.StatusNoContent, confirmReset(t, h, token, "long enough password").Code)
}

func TestPasswordResetRejectsCommonPassword(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)
	require.Equal(t, http.StatusAccepted, requestReset(t, h, "alice@example.com").Code)

	token := resetToken(t, resetMail(t, sender))
	w := confirmReset(t, h, token, "Password1234")
	require.Equal(t, http.StatusBadRequest, w.Code)
	payload := decode(t, w)
	require.Equal(t, "validation_failed", payload["code"])
	details := payload["details"].(map[string]any)
	require.Equal(t, "password", details["field"])
	require.Equal(t, "too_common", details["rule"])

	// The weak password must not have consumed the link.
	require.Equal(t, http.StatusNoContent, confirmReset(t, h, token, "long enough password").Code)
}

// TestPasswordResetDoesNotEnumerate proves an unknown address looks exactly like a
// known one.
func TestPasswordResetDoesNotEnumerate(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	known := requestReset(t, h, "alice@example.com")
	unknown := requestReset(t, h, "nobody@example.com")

	require.Equal(t, http.StatusAccepted, unknown.Code)
	require.Equal(t, known.Body.String(), unknown.Body.String())
	require.Equal(t, 1, resetMailCount(sender), "only the existing address may receive a reset mail")
}

func TestPasswordResetCooldownDropsSecondMail(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	require.Equal(t, http.StatusAccepted, requestReset(t, h, "alice@example.com").Code)
	require.Equal(t, http.StatusAccepted, requestReset(t, h, "alice@example.com").Code)

	require.Equal(t, 1, resetMailCount(sender), "a second request inside the cooldown must be silent")
}

// TestPasswordResetSurvivesDeliveryFailure keeps the response identical when the
// relay rejects the message: a distinctive failure would leak that the address exists.
func TestPasswordResetSurvivesDeliveryFailure(t *testing.T) {
	sender := &recordingMailer{err: context.DeadlineExceeded}
	h := newAPIHarnessWithMail(t, sender)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	w := requestReset(t, h, "alice@example.com")
	require.Equal(t, http.StatusAccepted, w.Code)
	require.Equal(t, "accepted", decode(t, w)["status"])
}

func TestPasswordResetRevokesExistingSessions(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)
	session := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, session.Code)

	accessToken, _ := decode(t, session)["access_token"].(string)
	require.NotEmpty(t, accessToken)

	require.Equal(t, http.StatusAccepted, requestReset(t, h, "alice@example.com").Code)
	token := resetToken(t, resetMail(t, sender))
	require.Equal(t, http.StatusNoContent, confirmReset(t, h, token, "yet another passphrase").Code)

	// The access token was minted before the reset. Its session row is revoked, so
	// refreshing with the old cookie must fail.
	refreshReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token/refresh", nil)
	refreshReq.AddCookie(session.Result().Cookies()[0])
	for _, cookie := range session.Result().Cookies() {
		refreshReq.AddCookie(cookie)
	}
	refreshReq.Header.Set("X-CSRF-Token", cookieValue(session, "pp_csrf"))
	require.NotEqual(t, http.StatusOK, h.do(t, refreshReq).Code)
}
