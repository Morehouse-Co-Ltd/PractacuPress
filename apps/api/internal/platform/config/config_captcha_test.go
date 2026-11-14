package config

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// clearCaptchaEnv blanks every human verification variable so a developer shell
// that exported one cannot change the outcome of these tests.
func clearCaptchaEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"CAPTCHA_TURNSTILE_SECRET",
		"CAPTCHA_HCAPTCHA_SECRET",
		"CAPTCHA_TURNSTILE_URL",
		"CAPTCHA_HCAPTCHA_URL",
		"CAPTCHA_TIMEOUT_SECONDS",
	} {
		t.Setenv(name, "")
	}
}

// TestCaptchaIsOptional pins the "no secret means the feature is off" contract:
// a deployment that never set a captcha variable still starts, and the guard then
// reports every site as unenforced instead of failing the boot.
func TestCaptchaIsOptional(t *testing.T) {
	setValidEnv(t)
	clearCaptchaEnv(t)

	cfg, err := Load()
	require.NoError(t, err)
	require.Empty(t, cfg.Captcha.TurnstileSecret)
	require.Empty(t, cfg.Captcha.HCaptchaSecret)
	require.Equal(t, 5*time.Second, cfg.Captcha.Timeout)
}

// TestCaptchaReadsSecretsAndOverrides proves the secrets come from the environment
// only, and that the optional per-provider endpoint override is read here rather
// than hard coded in the verifier.
func TestCaptchaReadsSecretsAndOverrides(t *testing.T) {
	setValidEnv(t)
	clearCaptchaEnv(t)
	t.Setenv("CAPTCHA_TURNSTILE_SECRET", "turnstile-secret")
	t.Setenv("CAPTCHA_HCAPTCHA_SECRET", "hcaptcha-secret")
	t.Setenv("CAPTCHA_TURNSTILE_URL", "https://turnstile.gateway.test/siteverify")
	t.Setenv("CAPTCHA_HCAPTCHA_URL", "https://hcaptcha.gateway.test/siteverify")
	t.Setenv("CAPTCHA_TIMEOUT_SECONDS", "12")

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "turnstile-secret", cfg.Captcha.TurnstileSecret)
	require.Equal(t, "hcaptcha-secret", cfg.Captcha.HCaptchaSecret)
	require.Equal(t, "https://turnstile.gateway.test/siteverify", cfg.Captcha.TurnstileURL)
	require.Equal(t, "https://hcaptcha.gateway.test/siteverify", cfg.Captcha.HCaptchaURL)
	require.Equal(t, 12*time.Second, cfg.Captcha.Timeout)
}

// TestCaptchaIgnoresRemovedRecaptchaVariables keeps the upgrade honest: a
// deployment that still exports the old reCAPTCHA variables must boot normally, and
// the values must not creep back into the configuration struct.
func TestCaptchaIgnoresRemovedRecaptchaVariables(t *testing.T) {
	setValidEnv(t)
	clearCaptchaEnv(t)
	t.Setenv("CAPTCHA_RECAPTCHA_SECRET", "left-over-secret")
	t.Setenv("CAPTCHA_RECAPTCHA_URL", "https://recaptcha.gateway.test/siteverify")
	t.Setenv("CAPTCHA_RECAPTCHA_MIN_SCORE", "not-a-number")

	cfg, err := Load()
	require.NoError(t, err)
	require.Empty(t, cfg.Captcha.TurnstileSecret)
	require.Empty(t, cfg.Captcha.HCaptchaSecret)
}

// TestCaptchaTimeoutBounds keeps a pathological value from holding a login open or
// failing it instantly.
func TestCaptchaTimeoutBounds(t *testing.T) {
	cases := []struct {
		name  string
		value string
		code  string
	}{
		{name: "zero", value: "0", code: "invalid_captcha_timeout_seconds"},
		{name: "negative", value: "-1", code: "invalid_captcha_timeout_seconds"},
		{name: "too long", value: "31", code: "invalid_captcha_timeout_seconds"},
		{name: "not a number", value: "five", code: "invalid_captcha_timeout_seconds"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setValidEnv(t)
			clearCaptchaEnv(t)
			t.Setenv("CAPTCHA_TIMEOUT_SECONDS", tc.value)

			_, err := Load()
			require.Error(t, err)

			var cfgErr *Error
			require.True(t, errors.As(err, &cfgErr))
			require.Equal(t, tc.code, cfgErr.Code)
		})
	}

	setValidEnv(t)
	clearCaptchaEnv(t)
	t.Setenv("CAPTCHA_TIMEOUT_SECONDS", "1")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, time.Second, cfg.Captcha.Timeout)
}
