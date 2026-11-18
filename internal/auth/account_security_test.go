package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
)

// acceptingAvatars records every reference the profile update validates.
type acceptingAvatars struct {
	calls int
}

func (a *acceptingAvatars) ValidateAvatar(_ context.Context, siteID, userID, assetID string) error {
	a.calls++
	if siteID == "" || userID == "" || assetID == "" {
		return auth.ErrAvatarInvalid
	}
	return nil
}

// rejectingAvatars models an asset that belongs to another member, is rejected, or
// is not an avatar.
type rejectingAvatars struct{}

func (rejectingAvatars) ValidateAvatar(context.Context, string, string, string) error {
	return auth.ErrAvatarInvalid
}

func bearer(req *http.Request, token string) {
	req.Header.Set("Authorization", "Bearer "+token)
}

func sessionToken(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	token, _ := decode(t, w)["access_token"].(string)
	require.NotEmpty(t, token)
	return token
}

func profileRequest(t *testing.T, h *apiHarness, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/me/profile", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	bearer(req, token)
	return h.do(t, req)
}

func TestProfileUpdateWritesDisplayNameBioAndAvatar(t *testing.T) {
	avatars := &acceptingAvatars{}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{avatars: avatars})
	session := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, session.Code)
	token := sessionToken(t, session)

	w := profileRequest(t, h, token,
		`{"display_name":"Alice Writer","bio":"  Writing about small tools.  ","avatar_media_id":"ast_123"}`)
	require.Equal(t, http.StatusOK, w.Code)

	payload := decode(t, w)
	require.Equal(t, "Alice Writer", payload["display_name"])
	require.Equal(t, "Writing about small tools.", payload["bio"], "the bio is trimmed")
	require.Equal(t, "ast_123", payload["avatar_media_id"])
	require.Equal(t, 1, avatars.calls)

	// The same fields are persisted on the account row the public profile reads.
	userID := payload["id"].(string)
	row, err := h.db.Client.User.Get(context.Background(), userID)
	require.NoError(t, err)
	require.NotNil(t, row.Bio)
	require.Equal(t, "Writing about small tools.", *row.Bio)
	require.NotNil(t, row.AvatarMediaID)
	require.Equal(t, "ast_123", *row.AvatarMediaID)
}

func TestProfileUpdateRejectsAnAvatarTheCallerDoesNotOwn(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{avatars: rejectingAvatars{}})
	session := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, session.Code)

	w := profileRequest(t, h, sessionToken(t, session), `{"avatar_media_id":"someone-elses"}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
	payload := decode(t, w)
	require.Equal(t, "validation_failed", payload["code"])
	require.Equal(t, "avatar_media_id", payload["details"].(map[string]any)["field"])
}

func TestProfileUpdateClearsBioAndAvatar(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{avatars: &acceptingAvatars{}})
	session := register(t, h, "alice@example.com")
	token := sessionToken(t, session)

	require.Equal(t, http.StatusOK,
		profileRequest(t, h, token, `{"bio":"hello","avatar_media_id":"ast_1"}`).Code)

	cleared := profileRequest(t, h, token, `{"bio":"","avatar_media_id":""}`)
	require.Equal(t, http.StatusOK, cleared.Code)
	payload := decode(t, cleared)
	require.NotContains(t, payload, "bio")
	require.NotContains(t, payload, "avatar_media_id")
}

func TestChangePasswordKeepsCurrentSessionAndRevokesOthers(t *testing.T) {
	h := newAPIHarness(t)

	first := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, first.Code)
	firstToken := sessionToken(t, first)

	second := login(t, h, "alice@example.com", "correct horse battery")
	require.Equal(t, http.StatusOK, second.Code)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/password/change", jsonBody(t, map[string]string{
		"current_password": "correct horse battery",
		"new_password":     "a brand new passphrase",
	}))
	req.Header.Set("Content-Type", "application/json")
	bearer(req, firstToken)
	for _, cookie := range first.Result().Cookies() {
		req.AddCookie(cookie)
	}
	w := h.do(t, req)
	require.Equal(t, http.StatusNoContent, w.Code)

	// The current refresh session survives.
	refreshFirst := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token/refresh", nil)
	for _, cookie := range first.Result().Cookies() {
		refreshFirst.AddCookie(cookie)
	}
	refreshFirst.Header.Set("X-CSRF-Token", cookieValue(first, "pp_csrf"))
	require.Equal(t, http.StatusOK, h.do(t, refreshFirst).Code, "the caller's own session must stay alive")

	// The other device is logged out.
	refreshSecond := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token/refresh", nil)
	for _, cookie := range second.Result().Cookies() {
		refreshSecond.AddCookie(cookie)
	}
	refreshSecond.Header.Set("X-CSRF-Token", cookieValue(second, "pp_csrf"))
	require.Equal(t, http.StatusUnauthorized, h.do(t, refreshSecond).Code, "other sessions must be revoked")

	require.Equal(t, http.StatusUnauthorized,
		login(t, h, "alice@example.com", "correct horse battery").Code)
	require.Equal(t, http.StatusOK,
		login(t, h, "alice@example.com", "a brand new passphrase").Code)
}

func TestChangePasswordRejectsWrongCurrentPassword(t *testing.T) {
	h := newAPIHarness(t)
	session := register(t, h, "alice@example.com")
	token := sessionToken(t, session)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/password/change", jsonBody(t, map[string]string{
		"current_password": "not the password",
		"new_password":     "a brand new passphrase",
	}))
	req.Header.Set("Content-Type", "application/json")
	bearer(req, token)
	w := h.do(t, req)

	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, "current_password", decode(t, w)["details"].(map[string]any)["field"])
	// The old password still works.
	require.Equal(t, http.StatusOK,
		login(t, h, "alice@example.com", "correct horse battery").Code)
}

// verificationToken finds the single use token in the registration verification mail.
func verificationToken(t *testing.T, sender *recordingMailer) string {
	t.Helper()
	for _, message := range sender.messages() {
		if strings.Contains(message.Text, "/verify-email?token=") {
			return resetToken(t, message)
		}
	}
	t.Fatal("verification mail is missing")
	return ""
}

func TestRegistrationSendsVerificationMailAndVerificationSticks(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)

	session := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, session.Code)
	token := sessionToken(t, session)

	// Soft verification: the account can use the API before it clicks the link.
	me := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	bearer(me, token)
	before := decode(t, h.do(t, me))
	require.Equal(t, false, before["user"].(map[string]any)["email_verified"])

	verify := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email/verify",
		bytes.NewBufferString(`{"token":"`+verificationToken(t, sender)+`"}`))
	verify.Header.Set("Content-Type", "application/json")
	require.Equal(t, http.StatusNoContent, h.do(t, verify).Code)

	after := decode(t, h.do(t, me))
	require.Equal(t, true, after["user"].(map[string]any)["email_verified"])

	// The token is single use.
	replay := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email/verify",
		bytes.NewBufferString(`{"token":"`+verificationToken(t, sender)+`"}`))
	replay.Header.Set("Content-Type", "application/json")
	require.Equal(t, http.StatusBadRequest, h.do(t, replay).Code)
}

func TestRequestEmailVerificationReportsAlreadyVerified(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)
	session := register(t, h, "alice@example.com")
	token := sessionToken(t, session)

	verify := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email/verify",
		bytes.NewBufferString(`{"token":"`+verificationToken(t, sender)+`"}`))
	verify.Header.Set("Content-Type", "application/json")
	require.Equal(t, http.StatusNoContent, h.do(t, verify).Code)

	resend := httptest.NewRequest(http.MethodPost, "/api/v1/me/email/verification", nil)
	bearer(resend, token)
	w := h.do(t, resend)
	require.Equal(t, http.StatusAccepted, w.Code)
	payload := decode(t, w)
	require.Equal(t, "already_verified", payload["status"])
	require.Equal(t, true, payload["already_verified"])
}

// Ensure the test bodies are valid JSON: a typo here would silently turn into a 400.
func TestAccountSecurityFixturesAreJSON(t *testing.T) {
	for _, body := range []string{
		`{"display_name":"Alice Writer","bio":"x","avatar_media_id":"ast_123"}`,
		`{"current_password":"a","new_password":"b"}`,
	} {
		require.True(t, json.Valid([]byte(body)), body)
	}
}
