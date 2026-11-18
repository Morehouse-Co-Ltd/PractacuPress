package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoadParsesCORSAndProxySettings(t *testing.T) {
	setValidEnv(t)
	t.Setenv("CORS_ALLOWED_ORIGINS", " https://app.example.com , https://admin.example.com ,, ")
	t.Setenv("CORS_ALLOW_CREDENTIALS", "true")
	t.Setenv("TRUSTED_PROXIES", "10.0.0.0/8,127.0.0.1")
	t.Setenv("RATE_LIMIT_PER_MINUTE", "60")

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, []string{"https://app.example.com", "https://admin.example.com"}, cfg.CORSAllowedOrigins)
	require.True(t, cfg.CORSCredentials)
	require.Equal(t, []string{"10.0.0.0/8", "127.0.0.1"}, cfg.TrustedProxies)
	require.Equal(t, 60, cfg.RateLimitPerMinute)
}

func TestLoadDefaultsRateLimit(t *testing.T) {
	setValidEnv(t)

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, DefaultRateLimitPerMinute, cfg.RateLimitPerMinute)
	require.Empty(t, cfg.CORSAllowedOrigins)
	require.False(t, cfg.CORSCredentials)
}

func TestLoadRejectsWildcardWithCredentials(t *testing.T) {
	setValidEnv(t)
	t.Setenv("CORS_ALLOWED_ORIGINS", "*")
	t.Setenv("CORS_ALLOW_CREDENTIALS", "1")

	_, err := Load()
	require.Error(t, err)
}

func TestLoadRejectsBadRateLimit(t *testing.T) {
	setValidEnv(t)
	t.Setenv("RATE_LIMIT_PER_MINUTE", "many")

	_, err := Load()
	require.Error(t, err)
}

func TestLoadRejectsNegativeRateLimit(t *testing.T) {
	setValidEnv(t)
	t.Setenv("RATE_LIMIT_PER_MINUTE", "-5")

	_, err := Load()
	require.Error(t, err)
}

// TestLoadRequiresPublicBaseURLWhenSMTPIsConfigured pins the fix for Host header
// poisoning of one-time mail links: once mail can leave the machine, the link
// origin must come from configuration, never from the request Host header.
func TestLoadRequiresPublicBaseURLWhenSMTPIsConfigured(t *testing.T) {
	setValidEnv(t)
	t.Setenv("SMTP_HOST", "127.0.0.1")
	t.Setenv("SMTP_FROM", "noreply@example.com")
	t.Setenv("PUBLIC_BASE_URL", "")

	_, err := Load()
	require.Error(t, err)

	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_public_base_url", cfgErr.Code)
}

func TestLoadAcceptsSMTPWithPublicBaseURL(t *testing.T) {
	setValidEnv(t)
	t.Setenv("SMTP_HOST", "127.0.0.1")
	t.Setenv("SMTP_FROM", "noreply@example.com")
	t.Setenv("PUBLIC_BASE_URL", "https://press.example.com")

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "https://press.example.com", cfg.PublicBaseURL)
	require.Equal(t, "127.0.0.1", cfg.SMTPHost)
}

// Desktop installs are loopback-only and keep the request origin fallback, so a
// local SMTP relay still works without PUBLIC_BASE_URL.
func TestDesktopModeKeepsRequestOriginFallbackWithoutPublicBaseURL(t *testing.T) {
	setValidEnv(t)
	t.Setenv("PP_DESKTOP", "1")
	t.Setenv("SMTP_HOST", "127.0.0.1")
	t.Setenv("SMTP_FROM", "noreply@example.com")
	t.Setenv("PUBLIC_BASE_URL", "")

	cfg, err := Load()
	require.NoError(t, err)
	require.True(t, cfg.DesktopMode)
	require.Empty(t, cfg.PublicBaseURL)
}
