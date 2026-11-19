package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/captcha"
)

// These tests wire the *real* guard and verifier onto the real router: the policy
// comes from a stored design document, the token is redeemed against a stub
// siteverify endpoint, and the assertion is on the HTTP answer the browser gets.
// The stub-guard tests cover the handler contract; this file covers the claim that
// "a site that switched the scene on is really challenged".

// providerStub records the siteverify calls the verifier makes.
type providerStub struct {
	calls [][2]string // secret, response, per call
}

func (p *providerStub) server(t *testing.T, answer string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		p.calls = append(p.calls, [2]string{r.PostForm.Get("secret"), r.PostForm.Get("response")})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(server.Close)
	return server
}

// siteDocument renders the stored design document a site would have after saving the
// settings page with exactly one scene protected.
func siteDocument(provider captcha.Provider, scene captcha.Scene) []byte {
	document := map[string]any{
		"enabled":           true,
		"provider":          string(provider),
		"site_key":          "public-site-key",
		"on_login":          scene == captcha.SceneLogin,
		"on_register":       scene == captcha.SceneRegister,
		"on_password_reset": scene == captcha.ScenePasswordReset,
		"on_comment":        scene == captcha.SceneComment,
	}
	raw, err := json.Marshal(map[string]any{"verification": document})
	if err != nil {
		panic(err)
	}
	return raw
}

// realGuard builds the production stack: one verifier, one guard and the site's
// stored intent. The audit trail has its own tests.
func realGuard(provider captcha.Provider, scene captcha.Scene, endpoint, secret string) *captcha.Guard {
	verifier := captcha.NewVerifier(captcha.Config{
		Secrets:   map[captcha.Provider]string{provider: secret},
		Endpoints: map[captcha.Provider]string{provider: endpoint},
	})
	return captcha.NewGuard(captcha.GuardConfig{
		Verifier: verifier,
		Customization: func(context.Context, string) ([]byte, error) {
			return siteDocument(provider, scene), nil
		},
	})
}

// detailReason reads `details.reason` without requiring a problem body: the reset
// endpoint answers 202 with no details when the challenge did not stop it.
func detailReason(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		return ""
	}
	details, ok := payload["details"].(map[string]any)
	if !ok {
		return ""
	}
	reason, _ := details["reason"].(string)
	return reason
}

// TestLoginIsChallengedByTheSitesStoredPolicy is the end-to-end version of the login
// scene: no token is refused before the credentials are looked at, and the token
// travels to the provider together with the server secret.
func TestLoginIsChallengedByTheSitesStoredPolicy(t *testing.T) {
	provider := &providerStub{}
	server := provider.server(t, `{"success":true}`)
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{
		captcha: realGuard(captcha.ProviderTurnstile, captcha.SceneLogin, server.URL, "server-secret"),
	})

	refused := postJSON(t, h, "/api/v1/auth/login/password", map[string]string{
		"email":    "alice@example.com",
		"password": "correct horse battery",
	})
	require.Equal(t, http.StatusBadRequest, refused.Code)
	require.Equal(t, "captcha_required", problemReason(t, refused))
	require.Empty(t, provider.calls, "a missing token must not reach the provider")

	accepted := postJSON(t, h, "/api/v1/auth/login/password", map[string]string{
		"email":         "alice@example.com",
		"password":      "correct horse battery",
		"captcha_token": "solved-once",
	})
	// The challenge passed, so the answer is the credential check's: no such account.
	require.Equal(t, http.StatusUnauthorized, accepted.Code)
	require.Len(t, provider.calls, 1)
	require.Equal(t, "server-secret", provider.calls[0][0])
	require.Equal(t, "solved-once", provider.calls[0][1])
}

// TestRegisterAndPasswordResetUseTheirOwnScene proves the scene reaches the guard per
// endpoint: a site that only protects registration must not challenge the reset form.
func TestRegisterAndPasswordResetUseTheirOwnScene(t *testing.T) {
	provider := &providerStub{}
	server := provider.server(t, `{"success":true}`)

	registerOnly := newAPIHarnessWithOptions(t, apiHarnessOptions{
		captcha: realGuard(captcha.ProviderTurnstile, captcha.SceneRegister, server.URL, "server-secret"),
	})

	register := postJSON(t, registerOnly, "/api/v1/auth/register/email", map[string]string{
		"email":        "bob@example.com",
		"password":     "correct horse battery",
		"display_name": "Bob",
	})
	require.Equal(t, http.StatusBadRequest, register.Code)
	require.Equal(t, "captcha_required", problemReason(t, register))

	// The reset form is not protected by this policy, so it must not be refused by
	// the challenge (this deployment has no mailer, so it stops at that layer).
	reset := postJSON(t, registerOnly, "/api/v1/auth/password-reset/request", map[string]string{
		"email": "bob@example.com",
	})
	require.NotEqual(t, "captcha_required", detailReason(t, reset))

	resetOnly := newAPIHarnessWithOptions(t, apiHarnessOptions{
		captcha: realGuard(captcha.ProviderTurnstile, captcha.ScenePasswordReset, server.URL, "server-secret"),
	})
	refusedReset := postJSON(t, resetOnly, "/api/v1/auth/password-reset/request", map[string]string{
		"email": "bob@example.com",
	})
	require.Equal(t, http.StatusBadRequest, refusedReset.Code)
	require.Equal(t, "captcha_required", problemReason(t, refusedReset))
}

// TestRedeemedTokenCannotBeReplayedOverHTTP covers the replay guard through the
// endpoint rather than through the verifier alone.
func TestRedeemedTokenCannotBeReplayedOverHTTP(t *testing.T) {
	provider := &providerStub{}
	server := provider.server(t, `{"success":true}`)
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{
		captcha: realGuard(captcha.ProviderTurnstile, captcha.SceneLogin, server.URL, "server-secret"),
	})

	first := postJSON(t, h, "/api/v1/auth/login/password", map[string]string{
		"email":         "alice@example.com",
		"password":      "correct horse battery",
		"captcha_token": "one-shot",
	})
	require.Equal(t, http.StatusUnauthorized, first.Code)

	second := postJSON(t, h, "/api/v1/auth/login/password", map[string]string{
		"email":         "alice@example.com",
		"password":      "correct horse battery",
		"captcha_token": "one-shot",
	})
	require.Equal(t, http.StatusBadRequest, second.Code)
	require.Equal(t, "captcha_replayed", problemReason(t, second))
	require.Len(t, provider.calls, 1, "the replay is refused locally")
}

// TestSiteEnabledWithoutAServerSecretIsNotEnforced pins the deployment boundary: the
// site's switch is on and this process holds no secret, so the form is *not*
// challenged (and no provider is called) instead of every visitor being locked out.
func TestSiteEnabledWithoutAServerSecretIsNotEnforced(t *testing.T) {
	provider := &providerStub{}
	server := provider.server(t, `{"success":true}`)
	// The process holds a secret for another provider only.
	verifier := captcha.NewVerifier(captcha.Config{
		Secrets:   map[captcha.Provider]string{captcha.ProviderHCaptcha: "hcaptcha-secret"},
		Endpoints: map[captcha.Provider]string{captcha.ProviderTurnstile: server.URL},
	})
	guard := captcha.NewGuard(captcha.GuardConfig{
		Verifier: verifier,
		Customization: func(context.Context, string) ([]byte, error) {
			return siteDocument(captcha.ProviderTurnstile, captcha.SceneLogin), nil
		},
	})
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{captcha: guard})

	w := postJSON(t, h, "/api/v1/auth/login/password", map[string]string{
		"email":    "alice@example.com",
		"password": "correct horse battery",
	})
	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Empty(t, provider.calls)
}

// TestLocalChallengeTokenIsEnforcedEndToEnd proves the self-hosted provider goes
// through the exact same guard path on the login endpoint: no token is refused, an
// issued-and-solved token lets the credential check run, and the token cannot be
// spent twice.
func TestLocalChallengeTokenIsEnforcedEndToEnd(t *testing.T) {
	store := captcha.NewLocalStore(captcha.LocalStoreConfig{})
	guard := captcha.NewGuard(captcha.GuardConfig{
		Verifier: captcha.NewVerifier(captcha.Config{Local: store}),
		Customization: func(context.Context, string) ([]byte, error) {
			return siteDocument(captcha.ProviderLocal, captcha.SceneLogin), nil
		},
	})
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{captcha: guard})

	refused := postJSON(t, h, "/api/v1/auth/login/password", map[string]string{
		"email":    "alice@example.com",
		"password": "correct horse battery",
	})
	require.Equal(t, http.StatusBadRequest, refused.Code)
	require.Equal(t, "captcha_required", problemReason(t, refused))

	challenge, answer, err := store.IssueWithAnswer(captcha.SceneLogin)
	require.NoError(t, err)
	token, _, err := store.Solve(challenge.ID, answer, captcha.SceneLogin)
	require.NoError(t, err)

	accepted := postJSON(t, h, "/api/v1/auth/login/password", map[string]string{
		"email":         "alice@example.com",
		"password":      "correct horse battery",
		"captcha_token": token,
	})
	// The local challenge passed, so the answer is the credential check's: no such
	// account.
	require.Equal(t, http.StatusUnauthorized, accepted.Code)

	replayed := postJSON(t, h, "/api/v1/auth/login/password", map[string]string{
		"email":         "alice@example.com",
		"password":      "correct horse battery",
		"captcha_token": token,
	})
	require.Equal(t, http.StatusBadRequest, replayed.Code)
	require.Equal(t, "captcha_replayed", problemReason(t, replayed))
}
