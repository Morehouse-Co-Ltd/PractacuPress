package captcha

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// newSiteVerify starts a fake provider endpoint. handler receives the parsed form
// so a test can assert what the verifier actually sent.
func newSiteVerify(t *testing.T, handler func(r *http.Request, form map[string]string) (int, string)) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		form := make(map[string]string, len(r.PostForm))
		for key := range r.PostForm {
			form[key] = r.PostForm.Get(key)
		}
		status, body := handler(r, form)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

func testVerifier(t *testing.T, endpoint string, secrets map[Provider]string, options ...func(*Config)) *Verifier {
	t.Helper()
	cfg := Config{
		Secrets:   secrets,
		Endpoints: map[Provider]string{ProviderTurnstile: endpoint, ProviderHCaptcha: endpoint, ProviderRecaptcha: endpoint},
		Timeout:   2 * time.Second,
	}
	for _, option := range options {
		option(&cfg)
	}
	return NewVerifier(cfg)
}

func TestVerifySendsTheSecretAndAcceptsAValidToken(t *testing.T) {
	var seen map[string]string
	server := newSiteVerify(t, func(_ *http.Request, form map[string]string) (int, string) {
		seen = form
		return http.StatusOK, `{"success":true,"hostname":"press.example","challenge_ts":"2026-11-07T10:00:00Z"}`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderTurnstile: "turnstile-secret"})
	result, err := verifier.Verify(context.Background(), Request{
		Provider: ProviderTurnstile,
		Token:    "token-1",
		RemoteIP: "203.0.113.7",
		Scene:    SceneLogin,
	})
	require.NoError(t, err)
	require.Equal(t, ProviderTurnstile, result.Provider)
	require.Equal(t, "press.example", result.Hostname)

	// The provider must receive the secret and the solved token; this is the whole
	// contract of siteverify.
	require.Equal(t, "turnstile-secret", seen["secret"])
	require.Equal(t, "token-1", seen["response"])
	require.Equal(t, "203.0.113.7", seen["remoteip"])
}

func TestVerifyReportsAProviderRefusal(t *testing.T) {
	server := newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
		return http.StatusOK, `{"success":false,"error-codes":["invalid-input-response"]}`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderTurnstile: "s"})
	_, err := verifier.Verify(context.Background(), Request{Provider: ProviderTurnstile, Token: "bad"})
	require.ErrorIs(t, err, ErrRejected)
}

func TestVerifyRejectsAReplayedToken(t *testing.T) {
	calls := 0
	server := newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
		calls++
		return http.StatusOK, `{"success":true}`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderTurnstile: "s"})
	request := Request{Provider: ProviderTurnstile, Token: "once"}

	_, err := verifier.Verify(context.Background(), request)
	require.NoError(t, err)
	_, err = verifier.Verify(context.Background(), request)
	require.ErrorIs(t, err, ErrReplay)

	// The second attempt must not even reach the provider: a replay is decided
	// locally, so a captured token costs no upstream call.
	require.Equal(t, 1, calls)
}

func TestVerifyReplayExpires(t *testing.T) {
	now := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	server := newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
		return http.StatusOK, `{"success":true}`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderTurnstile: "s"}, func(cfg *Config) {
		cfg.ReplayTTL = time.Minute
		cfg.Now = func() time.Time { return now }
	})
	request := Request{Provider: ProviderTurnstile, Token: "old"}

	_, err := verifier.Verify(context.Background(), request)
	require.NoError(t, err)
	now = now.Add(2 * time.Minute)
	_, err = verifier.Verify(context.Background(), request)
	require.NoError(t, err, "a token older than its TTL may be redeemed again")
}

func TestVerifyTimesOutWithoutBurningTheToken(t *testing.T) {
	server := newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
		time.Sleep(200 * time.Millisecond)
		return http.StatusOK, `{"success":true}`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderTurnstile: "s"}, func(cfg *Config) {
		cfg.Timeout = 20 * time.Millisecond
	})
	request := Request{Provider: ProviderTurnstile, Token: "slow"}

	_, err := verifier.Verify(context.Background(), request)
	require.ErrorIs(t, err, ErrTimeout)

	// A timeout is a retryable transport failure, not a solved-and-used challenge:
	// the same token may be submitted again.
	require.False(t, verifier.seen(ProviderTurnstile, request.Token))
}

func TestVerifyReportsAnUpstreamError(t *testing.T) {
	server := newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
		return http.StatusInternalServerError, `{"success":false}`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderTurnstile: "s"})
	_, err := verifier.Verify(context.Background(), Request{Provider: ProviderTurnstile, Token: "x"})
	require.ErrorIs(t, err, ErrUpstream)
}

func TestVerifyReportsMalformedUpstreamJSON(t *testing.T) {
	server := newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
		return http.StatusOK, `<html>not json</html>`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderTurnstile: "s"})
	_, err := verifier.Verify(context.Background(), Request{Provider: ProviderTurnstile, Token: "x"})
	require.ErrorIs(t, err, ErrUpstream)
}

func TestVerifyWithoutSecretIsNotConfigured(t *testing.T) {
	verifier := NewVerifier(Config{})
	require.False(t, verifier.Configured(ProviderTurnstile))
	require.Empty(t, verifier.ConfiguredProviders())

	_, err := verifier.Verify(context.Background(), Request{Provider: ProviderTurnstile, Token: "x"})
	require.ErrorIs(t, err, ErrNotConfigured)
}

func TestVerifyRequiresAToken(t *testing.T) {
	verifier := testVerifier(t, "http://127.0.0.1:1", map[Provider]string{ProviderTurnstile: "s"})
	_, err := verifier.Verify(context.Background(), Request{Provider: ProviderTurnstile, Token: "  "})
	require.ErrorIs(t, err, ErrTokenMissing)
}

func TestVerifySendsSiteKeyToHCaptcha(t *testing.T) {
	var seen map[string]string
	server := newSiteVerify(t, func(_ *http.Request, form map[string]string) (int, string) {
		seen = form
		return http.StatusOK, `{"success":true}`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderHCaptcha: "s"})
	_, err := verifier.Verify(context.Background(), Request{
		Provider: ProviderHCaptcha,
		Token:    "t",
		SiteKey:  "10000000-ffff-ffff-ffff-000000000001",
	})
	require.NoError(t, err)
	require.Equal(t, "10000000-ffff-ffff-ffff-000000000001", seen["sitekey"])
}

func TestVerifyRecaptchaV3EnforcesTheScore(t *testing.T) {
	server := newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
		body, _ := json.Marshal(map[string]any{
			"success": true,
			"score":   0.2,
			"action":  "login",
		})
		return http.StatusOK, string(body)
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderRecaptcha: "s"}, func(cfg *Config) {
		cfg.MinScore = 0.5
	})
	_, err := verifier.Verify(context.Background(), Request{
		Provider: ProviderRecaptcha,
		Token:    "low",
		Scene:    SceneLogin,
	})
	require.ErrorIs(t, err, ErrScoreTooLow)

	// A low score is a refusal (solve again), not a used token: the visitor gets
	// another attempt.
	require.False(t, verifier.seen(ProviderRecaptcha, "low"))
}

func TestVerifyRecaptchaV3EnforcesTheAction(t *testing.T) {
	server := newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
		return http.StatusOK, `{"success":true,"score":0.9,"action":"comment"}`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderRecaptcha: "s"})
	_, err := verifier.Verify(context.Background(), Request{
		Provider: ProviderRecaptcha,
		Token:    "wrong-form",
		Scene:    SceneLogin,
	})
	require.ErrorIs(t, err, ErrActionMismatch)
}

func TestVerifyRecaptchaV2HasNoScoreOrAction(t *testing.T) {
	// reCAPTCHA v2 answers with neither score nor action; treating a missing score
	// as zero would reject every v2 deployment.
	server := newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
		return http.StatusOK, `{"success":true,"hostname":"press.example"}`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderRecaptcha: "s"})
	_, err := verifier.Verify(context.Background(), Request{
		Provider: ProviderRecaptcha,
		Token:    "v2",
		Scene:    SceneLogin,
	})
	require.NoError(t, err)
}

func TestVerifyRecaptchaV3AcceptsAMatchingAction(t *testing.T) {
	server := newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
		return http.StatusOK, `{"success":true,"score":0.9,"action":"register"}`
	})

	verifier := testVerifier(t, server.URL, map[Provider]string{ProviderRecaptcha: "s"})
	result, err := verifier.Verify(context.Background(), Request{
		Provider: ProviderRecaptcha,
		Token:    "ok",
		Scene:    SceneRegister,
	})
	require.NoError(t, err)
	require.NotNil(t, result.Score)
	require.InDelta(t, 0.9, *result.Score, 0.001)
}

func TestVerifyUsesTheOfficialEndpointByDefault(t *testing.T) {
	require.Contains(t, defaultEndpoint(ProviderTurnstile), "challenges.cloudflare.com")
	require.Contains(t, defaultEndpoint(ProviderHCaptcha), "hcaptcha.com")
	require.Contains(t, defaultEndpoint(ProviderRecaptcha), "google.com")
}

func TestVerifyRejectsAnUnknownProvider(t *testing.T) {
	verifier := NewVerifier(Config{Secrets: map[Provider]string{"mystery": "s"}})
	_, err := verifier.Verify(context.Background(), Request{Provider: "mystery", Token: "x"})
	require.True(t, errors.Is(err, ErrProviderUnknown))
}
