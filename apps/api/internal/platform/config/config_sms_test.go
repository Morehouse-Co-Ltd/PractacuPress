package config

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// clearSMSEnv blanks every phone login variable so a developer shell that exported
// one cannot change the outcome of these tests.
func clearSMSEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"SMS_PROVIDER",
		"SMS_HTTP_URL",
		"SMS_HTTP_TOKEN",
		"SMS_DEV_MODE",
		"SMS_CODE_TTL_SECONDS",
	} {
		t.Setenv(name, "")
	}
}

// TestSMSDefaultsToOff pins contract A: phone login is an optional capability and
// the default deployment does not claim to send codes.
func TestSMSDefaultsToOff(t *testing.T) {
	setValidEnv(t)
	clearSMSEnv(t)

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, SMSProviderOff, cfg.SMSProvider)
	require.False(t, cfg.SMSDevMode)
	require.Equal(t, DefaultSMSCodeTTL, cfg.SMSCodeTTL)
	require.Empty(t, cfg.SMSHTTPURL)
}

func TestSMSRejectsUnknownProvider(t *testing.T) {
	setValidEnv(t)
	clearSMSEnv(t)
	t.Setenv("SMS_PROVIDER", "carrier-pigeon")

	_, err := Load()
	require.Error(t, err)

	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_sms_provider", cfgErr.Code)
}

func TestSMSHTTPRequiresURL(t *testing.T) {
	setValidEnv(t)
	clearSMSEnv(t)
	t.Setenv("SMS_PROVIDER", SMSProviderHTTP)

	_, err := Load()
	require.Error(t, err)

	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "missing_sms_http_url", cfgErr.Code)
}

func TestSMSHTTPValidatesURL(t *testing.T) {
	setValidEnv(t)
	clearSMSEnv(t)
	t.Setenv("SMS_PROVIDER", SMSProviderHTTP)

	cases := map[string]string{
		"relative":       "/send",
		"bad scheme":     "ftp://gateway.example.com/send",
		"remote http":    "http://gateway.example.com/send",
		"no host":        "https://",
		"not a full url": "gateway.example.com/send",
	}
	for name, url := range cases {
		t.Run(name, func(t *testing.T) {
			t.Setenv("SMS_HTTP_URL", url)
			_, err := Load()
			require.Error(t, err)
		})
	}
}

func TestSMSHTTPAcceptsLoopbackAndHTTPS(t *testing.T) {
	setValidEnv(t)
	clearSMSEnv(t)
	t.Setenv("SMS_PROVIDER", SMSProviderHTTP)

	t.Setenv("SMS_HTTP_URL", "https://gateway.example.com/send")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "https://gateway.example.com/send", cfg.SMSHTTPURL)

	// The test suite points the gateway at an httptest server, which is plain HTTP on
	// loopback; that is the one plaintext case the config accepts.
	t.Setenv("SMS_HTTP_URL", "http://127.0.0.1:9999/send")
	_, err = Load()
	require.NoError(t, err)
}

func TestSMSDevModeIsRefusedInProduction(t *testing.T) {
	setValidEnv(t)
	clearSMSEnv(t)
	t.Setenv("APP_ENV", EnvProduction)
	// Production refuses to boot without the at-rest encryption keys, and that check
	// runs before the SMS block; supply them so the assertion reaches the rule under
	// test.
	t.Setenv("FIELD_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef")
	t.Setenv("BACKUP_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef")
	t.Setenv("SMS_PROVIDER", SMSProviderLog)
	t.Setenv("SMS_DEV_MODE", "true")

	_, err := Load()
	require.Error(t, err)

	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_sms_dev_mode", cfgErr.Code)
}

func TestSMSCodeTTLBounds(t *testing.T) {
	setValidEnv(t)
	clearSMSEnv(t)
	t.Setenv("SMS_PROVIDER", SMSProviderLog)

	t.Setenv("SMS_CODE_TTL_SECONDS", "120")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 120*time.Second, cfg.SMSCodeTTL)

	for _, invalid := range []string{"10", "7200"} {
		t.Setenv("SMS_CODE_TTL_SECONDS", invalid)
		_, err := Load()
		require.Error(t, err)

		var cfgErr *Error
		require.True(t, errors.As(err, &cfgErr))
		require.Equal(t, "invalid_sms_code_ttl_seconds", cfgErr.Code)
	}
}
