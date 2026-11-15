package captcha

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseSettingsReadsTheStoredSection(t *testing.T) {
	document := []byte(`{
		"theme": {"accent": "#000"},
		"verification": {
			"enabled": true,
			"provider": "hcaptcha",
			"site_key": " 10000000-ffff-ffff-ffff-000000000001 ",
			"on_login": true,
			"on_register": false,
			"on_comment": true,
			"on_password_reset": true
		}
	}`)

	settings := ParseSettings(document)
	require.True(t, settings.Enabled)
	require.Equal(t, ProviderHCaptcha, settings.Provider)
	// The site key is trimmed: a copy-pasted key with a trailing newline would
	// otherwise be rejected by the provider and look like a broken feature.
	require.Equal(t, "10000000-ffff-ffff-ffff-000000000001", settings.SiteKey)
	require.True(t, settings.SceneEnabled(SceneLogin))
	require.False(t, settings.SceneEnabled(SceneRegister))
	require.True(t, settings.SceneEnabled(SceneComment))
	require.True(t, settings.SceneEnabled(ScenePasswordReset))
}

func TestParseSettingsDefaultsToOff(t *testing.T) {
	for name, document := range map[string][]byte{
		"empty":          nil,
		"not json":       []byte("not json"),
		"no section":     []byte(`{"theme":{}}`),
		"null section":   []byte(`{"verification":null}`),
		"empty section":  []byte(`{"verification":{}}`),
		"array document": []byte(`[]`),
	} {
		t.Run(name, func(t *testing.T) {
			settings := ParseSettings(document)
			require.False(t, settings.Enabled, "an unreadable document must not protect anything")
			require.Equal(t, ProviderTurnstile, settings.Provider)
			require.Empty(t, settings.SiteKey)
		})
	}
}

func TestParseSettingsDisablesAnUnknownProvider(t *testing.T) {
	// A provider this build does not know cannot be verified by any client, so an
	// enabled section that names it must read as off instead of failing every form.
	settings := ParseSettings([]byte(`{"verification":{"enabled":true,"provider":"mystery","site_key":"k"}}`))
	require.False(t, settings.Enabled)
}

// TestParseSettingsNormalizesLegacyRecaptcha is the upgrade contract: Google
// reCAPTCHA was removed from the product, but a site that saved it must not be
// locked out (unknown provider would read as off). The stored intent is rewritten
// to Turnstile, which every deployment can still render.
func TestParseSettingsNormalizesLegacyRecaptcha(t *testing.T) {
	settings := ParseSettings([]byte(`{
		"verification": {
			"enabled": true,
			"provider": "recaptcha",
			"site_key": "legacy-site-key",
			"on_login": true
		}
	}`))
	require.True(t, settings.Enabled)
	require.Equal(t, ProviderTurnstile, settings.Provider)
	require.Equal(t, "legacy-site-key", settings.SiteKey)
	require.True(t, settings.SceneEnabled(SceneLogin))
}

// TestProvidersListsTheSelectableProviders pins the settings page order and keeps the
// removed reCAPTCHA provider from creeping back in.
func TestProvidersListsTheSelectableProviders(t *testing.T) {
	require.Equal(t, []Provider{ProviderTurnstile, ProviderHCaptcha, ProviderLocal}, Providers)
	require.True(t, ProviderLocal.Valid())
	require.False(t, Provider("recaptcha").Valid(), "reCAPTCHA is removed; only the legacy name is normalised")
	require.Equal(t, ProviderTurnstile, Provider("recaptcha").Normalize())
	require.Equal(t, "本地图形验证", ProviderLocal.Label())
	require.False(t, ProviderLocal.RequiresSiteKey())
	require.True(t, ProviderTurnstile.RequiresSiteKey())
}

func TestParseSettingsKeepsExplicitFalseSwitches(t *testing.T) {
	settings := ParseSettings([]byte(`{
		"verification": {"enabled": true, "provider": "turnstile", "site_key": "k", "on_login": false}
	}`))
	require.True(t, settings.Enabled)
	require.False(t, settings.SceneEnabled(SceneLogin))
	// Omitted switch keeps the documented default.
	require.True(t, settings.SceneEnabled(SceneRegister))
	// Password reset is opt-in for documents written before the switch existed,
	// so an upgrade never starts challenging a form the operator did not protect.
	require.False(t, settings.SceneEnabled(ScenePasswordReset))
}

func TestPolicySceneEnforcedRequiresEveryCondition(t *testing.T) {
	settings := Settings{
		Enabled:    true,
		Provider:   ProviderTurnstile,
		SiteKey:    "key",
		OnLogin:    true,
		OnRegister: true,
		OnComment:  false,
	}

	require.True(t, Policy{Settings: settings, SecretConfigured: true, Effective: true}.
		SceneEnforced(SceneLogin))
	require.False(t, Policy{Settings: settings, SecretConfigured: true, Effective: true}.
		SceneEnforced(SceneComment), "the operator switched comments off")
	require.False(t, Policy{Settings: settings, SecretConfigured: false, Effective: false}.
		SceneEnforced(SceneLogin), "no server secret means nothing is enforced")
}

func TestReasonIsStableAndTotal(t *testing.T) {
	require.Equal(t, "captcha_required", Reason(ErrTokenMissing))
	require.Equal(t, "captcha_invalid", Reason(ErrRejected))
	require.Equal(t, "captcha_replayed", Reason(ErrReplay))
	require.Equal(t, "captcha_score_too_low", Reason(ErrScoreTooLow))
	require.Equal(t, "captcha_action_mismatch", Reason(ErrActionMismatch))
	require.Equal(t, "captcha_unavailable", Reason(ErrTimeout))
	require.Equal(t, "captcha_unavailable", Reason(ErrUpstream))
	require.Equal(t, "captcha_failed", Reason(errors.New("anything else")))
	require.Empty(t, Reason(nil))
}

func TestSceneActionMatchesTheSceneName(t *testing.T) {
	// The frontend executes reCAPTCHA v3 with this action, so the two sides must
	// agree on the vocabulary; a test is cheaper than a production mismatch.
	require.Equal(t, "login", SceneLogin.Action())
	require.Equal(t, "register", SceneRegister.Action())
	require.Equal(t, "password_reset", ScenePasswordReset.Action())
	require.Equal(t, "comment", SceneComment.Action())
}
