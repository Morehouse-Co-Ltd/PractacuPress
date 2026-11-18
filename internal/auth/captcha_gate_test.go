package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/captcha"
)

// stubCaptcha is a guard whose verdict the test decides. It records the calls so a
// test can assert which scene and token reached it.
type stubCaptcha struct {
	err   error
	calls []captcha.RequireInput
}

func (s *stubCaptcha) Require(_ context.Context, in captcha.RequireInput) error {
	s.calls = append(s.calls, in)
	return s.err
}

func postJSON(t *testing.T, h *apiHarness, path string, values map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, jsonBody(t, values))
	req.Header.Set("Content-Type", "application/json")
	return h.do(t, req)
}

func TestRegisterIsRefusedWithoutASolvedChallenge(t *testing.T) {
	guard := &stubCaptcha{err: captcha.ErrTokenMissing}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{captcha: guard})

	w := postJSON(t, h, "/api/v1/auth/register/email", map[string]string{
		"email":        "alice@example.com",
		"password":     "correct horse battery",
		"display_name": "Alice",
	})

	require.Equal(t, http.StatusBadRequest, w.Code)
	payload := decode(t, w)
	require.Equal(t, "validation_failed", payload["code"])
	details, ok := payload["details"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "captcha_required", details["reason"])
	require.Equal(t, "captcha_token", details["field"])

	// The guard ran before the service: the request carried no token and the
	// register scene is the one that was asked about.
	require.Len(t, guard.calls, 1)
	require.Equal(t, captcha.SceneRegister, guard.calls[0].Scene)
	require.Empty(t, guard.calls[0].Token)

	// Nothing was written, so the same address can register once the visitor
	// solves the challenge.
	require.Zero(t, h.db.Client.User.Query().CountX(context.Background()))
}

func TestLoginPassesTheSolvedTokenToTheGuard(t *testing.T) {
	guard := &stubCaptcha{}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{captcha: guard})

	w := postJSON(t, h, "/api/v1/auth/login/password", map[string]string{
		"email":         "nobody@example.com",
		"password":      "correct horse battery",
		"captcha_token": "solved-token",
	})

	// The guard allowed the request, so the failure is the account lookup's, not
	// the challenge's.
	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Len(t, guard.calls, 1)
	require.Equal(t, captcha.SceneLogin, guard.calls[0].Scene)
	require.Equal(t, "solved-token", guard.calls[0].Token)
}

func TestPasswordResetIsRefusedWithoutASolvedChallenge(t *testing.T) {
	guard := &stubCaptcha{err: captcha.ErrRejected}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{captcha: guard})

	w := postJSON(t, h, "/api/v1/auth/password-reset/request", map[string]string{
		"email": "alice@example.com",
	})

	require.Equal(t, http.StatusBadRequest, w.Code)
	details, ok := decode(t, w)["details"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "captcha_invalid", details["reason"])
	require.Len(t, guard.calls, 1)
	require.Equal(t, captcha.ScenePasswordReset, guard.calls[0].Scene)
}

func TestUnavailableCaptchaAnswersServiceUnavailable(t *testing.T) {
	guard := &stubCaptcha{err: captcha.ErrTimeout}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{captcha: guard})

	w := postJSON(t, h, "/api/v1/auth/login/password", map[string]string{
		"email":         "alice@example.com",
		"password":      "correct horse battery",
		"captcha_token": "t",
	})

	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	payload := decode(t, w)
	require.Equal(t, "security_unavailable", payload["code"])
	details, ok := payload["details"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "captcha_unavailable", details["reason"])
}
