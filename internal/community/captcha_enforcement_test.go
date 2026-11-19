package community

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/captcha"
)

// TestCommentIsChallengedByTheRealGuard wires the production guard onto the comment
// endpoint: the policy is parsed from the site's stored document, the token is
// redeemed against a stub siteverify endpoint, and the comment is only written when
// the challenge passes. The stub-guard tests cover the handler contract; this one
// covers the claim that the comment path is protected *on the server*.
func TestCommentIsChallengedByTheRealGuard(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(server.Close)

	verifier := captcha.NewVerifier(captcha.Config{
		Secrets:   map[captcha.Provider]string{captcha.ProviderTurnstile: "server-secret"},
		Endpoints: map[captcha.Provider]string{captcha.ProviderTurnstile: server.URL},
	})
	guard := captcha.NewGuard(captcha.GuardConfig{
		Verifier: verifier,
		Customization: func(context.Context, string) ([]byte, error) {
			// The document the settings page saves when the comment scene is on.
			return []byte(`{"verification":{"enabled":true,"provider":"turnstile",` +
				`"site_key":"public-site-key","on_login":true,"on_register":true,"on_comment":true}}`), nil
		},
	})

	repo := newFakeRepo()
	r := newEngineWithCaptcha(repo, memberActor(), guard)

	refused := do(r, http.MethodPost, "/comments",
		`{"target_type":"article","target_id":"a1","body":"hello"}`)
	require.Equal(t, http.StatusBadRequest, refused.Code)
	var problem struct {
		Details map[string]any `json:"details"`
	}
	require.NoError(t, decodeJSON(refused.Body.Bytes(), &problem))
	require.Equal(t, "captcha_required", problem.Details["reason"])
	require.Zero(t, repo.writes, "a refused challenge must not store the comment")
	require.Zero(t, calls, "a missing token must not reach the provider")

	accepted := do(r, http.MethodPost, "/comments",
		`{"target_type":"article","target_id":"a1","body":"hello","captcha_token":"solved"}`)
	require.Equal(t, http.StatusCreated, accepted.Code, accepted.Body.String())
	require.Equal(t, 1, calls)
}
