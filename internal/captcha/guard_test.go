package captcha

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/audit"
)

type recordingAuditor struct {
	mu      sync.Mutex
	entries []audit.Entry
	err     error
}

func (r *recordingAuditor) Record(_ context.Context, entry audit.Entry) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	r.entries = append(r.entries, entry)
	return nil
}

func (r *recordingAuditor) all() []audit.Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]audit.Entry, len(r.entries))
	copy(out, r.entries)
	return out
}

func verificationDocument(t *testing.T, enabled bool, provider Provider) []byte {
	t.Helper()
	return []byte(`{"verification":{"enabled":` + boolLiteral(enabled) +
		`,"provider":"` + string(provider) + `","site_key":"site-key",` +
		`"on_login":true,"on_register":true,"on_password_reset":true,"on_comment":false}}`)
}

func boolLiteral(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func newGuard(t *testing.T, document []byte, secrets map[Provider]string, options ...func(*GuardConfig)) (*Guard, *recordingAuditor, *bytes.Buffer) {
	t.Helper()
	auditor := &recordingAuditor{}
	var logs bytes.Buffer
	cfg := GuardConfig{
		Verifier: NewVerifier(Config{
			Secrets:   secrets,
			Endpoints: map[Provider]string{},
			Timeout:   time.Second,
		}),
		Customization: func(context.Context, string) ([]byte, error) { return document, nil },
		Audit:         auditor,
		Logger:        slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	}
	for _, option := range options {
		option(&cfg)
	}
	return NewGuard(cfg), auditor, &logs
}

func TestGuardAllowsAnUnprotectedSceneWithoutCallingTheProvider(t *testing.T) {
	guard, auditor, _ := newGuard(t, verificationDocument(t, true, ProviderTurnstile), nil)
	// No secret: the site switched captcha on but the deployment cannot enforce it,
	// so the visitor must not be blocked by a check that cannot succeed.
	require.NoError(t, guard.Require(context.Background(), RequireInput{
		SiteID: "site", Scene: SceneLogin,
	}))
	require.Empty(t, auditor.all())
}

func TestGuardWarnsWhenASiteEnabledCaptchaWithoutASecret(t *testing.T) {
	guard, _, logs := newGuard(t, verificationDocument(t, true, ProviderTurnstile), nil)
	require.NoError(t, guard.Require(context.Background(), RequireInput{
		SiteID: "site", Scene: SceneLogin, Token: "x",
	}))

	output := logs.String()
	require.Contains(t, output, "cannot be enforced")
	require.Contains(t, output, "CAPTCHA_TURNSTILE_SECRET")
}

func TestGuardDoesNotWarnRepeatedly(t *testing.T) {
	guard, _, logs := newGuard(t, verificationDocument(t, true, ProviderTurnstile), nil)
	for index := 0; index < 5; index++ {
		require.NoError(t, guard.Require(context.Background(), RequireInput{
			SiteID: "site", Scene: SceneLogin, Token: "x",
		}))
	}
	require.Equal(t, 1, strings.Count(logs.String(), "cannot be enforced"))
}

func TestGuardRejectsAMissingToken(t *testing.T) {
	guard, auditor, _ := newGuard(t, verificationDocument(t, true, ProviderTurnstile),
		map[Provider]string{ProviderTurnstile: "secret"})

	err := guard.Require(context.Background(), RequireInput{
		SiteID: "site", Scene: SceneLogin, RequestID: "req-1", RemoteIP: "203.0.113.7",
	})
	require.ErrorIs(t, err, ErrTokenMissing)

	entries := auditor.all()
	require.Len(t, entries, 1)
	require.Equal(t, "auth.captcha.failed", entries[0].Action)
	require.Equal(t, "failure", entries[0].Outcome)
	require.Equal(t, "req-1", entries[0].RequestID)
	require.Equal(t, "captcha_required", entries[0].Detail["reason"])
	require.Equal(t, "login", entries[0].Detail["scene"])
	require.Equal(t, "turnstile", entries[0].Detail["provider"])
}

func TestGuardAcceptsAValidToken(t *testing.T) {
	var accepted bool
	guard, auditor, _ := newGuard(t, verificationDocument(t, true, ProviderTurnstile),
		map[Provider]string{ProviderTurnstile: "secret"})
	guard.verifier = NewVerifier(Config{
		Secrets: map[Provider]string{ProviderTurnstile: "secret"},
		Endpoints: map[Provider]string{
			ProviderTurnstile: newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
				accepted = true
				return http.StatusOK, `{"success":true}`
			}).URL,
		},
		Timeout: time.Second,
	})

	require.NoError(t, guard.Require(context.Background(), RequireInput{
		SiteID: "site", Scene: SceneLogin, Token: "good",
	}))
	require.True(t, accepted)
	require.Empty(t, auditor.all(), "a passed challenge is not an audit event")
}

func TestGuardKeepsAnEventedSceneUnprotected(t *testing.T) {
	// The stored document switches comments off; a comment must not need a token.
	guard, _, _ := newGuard(t, verificationDocument(t, true, ProviderTurnstile),
		map[Provider]string{ProviderTurnstile: "secret"})

	require.NoError(t, guard.Require(context.Background(), RequireInput{
		SiteID: "site", Scene: SceneComment,
	}))
}

func TestGuardTreatsADisabledSiteAsUnprotected(t *testing.T) {
	guard, auditor, _ := newGuard(t, verificationDocument(t, false, ProviderTurnstile),
		map[Provider]string{ProviderTurnstile: "secret"})

	require.NoError(t, guard.Require(context.Background(), RequireInput{
		SiteID: "site", Scene: SceneLogin,
	}))
	require.Empty(t, auditor.all())
}

func TestGuardFailsClosedWhenThePolicyCannotBeRead(t *testing.T) {
	guard, _, _ := newGuard(t, nil, nil, func(cfg *GuardConfig) {
		cfg.Customization = func(context.Context, string) ([]byte, error) {
			return nil, errors.New("database is down")
		}
	})

	err := guard.Require(context.Background(), RequireInput{SiteID: "site", Scene: SceneLogin})
	require.ErrorIs(t, err, ErrPolicyUnavailable)
}

func TestGuardReportsAProviderOutage(t *testing.T) {
	guard, auditor, _ := newGuard(t, verificationDocument(t, true, ProviderTurnstile),
		map[Provider]string{ProviderTurnstile: "secret"})
	guard.verifier = NewVerifier(Config{
		Secrets: map[Provider]string{ProviderTurnstile: "secret"},
		Endpoints: map[Provider]string{
			ProviderTurnstile: newSiteVerify(t, func(*http.Request, map[string]string) (int, string) {
				return http.StatusServiceUnavailable, `{"success":false}`
			}).URL,
		},
		Timeout: time.Second,
	})

	err := guard.Require(context.Background(), RequireInput{
		SiteID: "site", Scene: SceneLogin, Token: "t",
	})
	require.ErrorIs(t, err, ErrUpstream)
	require.Equal(t, "captcha_unavailable", auditor.all()[0].Detail["reason"])
}

func TestGuardPolicyReportsEffectiveOnlyWithSecretAndSiteKey(t *testing.T) {
	guard, _, _ := newGuard(t, verificationDocument(t, true, ProviderTurnstile),
		map[Provider]string{ProviderTurnstile: "secret"})
	policy, err := guard.Policy(context.Background(), "site")
	require.NoError(t, err)
	require.True(t, policy.Effective)
	require.True(t, policy.SecretConfigured)
	require.True(t, policy.SceneEnforced(SceneLogin))
	require.False(t, policy.SceneEnforced(SceneComment))

	withoutSecret, _, _ := newGuard(t, verificationDocument(t, true, ProviderTurnstile), nil)
	policy, err = withoutSecret.Policy(context.Background(), "site")
	require.NoError(t, err)
	require.False(t, policy.Effective)
	require.False(t, policy.SceneEnforced(SceneLogin))
}

func TestGuardPolicyWithoutASiteIsOff(t *testing.T) {
	guard, _, _ := newGuard(t, verificationDocument(t, true, ProviderTurnstile),
		map[Provider]string{ProviderTurnstile: "secret"})
	policy, err := guard.Policy(context.Background(), "")
	require.NoError(t, err)
	require.False(t, policy.Effective)
}
