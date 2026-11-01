package config

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func setValidEnv(t *testing.T) {
	t.Helper()
	t.Setenv("APP_ENV", EnvTest)
	t.Setenv("HTTP_ADDR", "")
	t.Setenv("DATABASE_DRIVER", DriverSQLite)
	t.Setenv("DATABASE_DSN", "file:test.db")
	t.Setenv("SECURITY_GRPC_ADDR", "127.0.0.1:9001")
}

func TestLoadRequiresEnv(t *testing.T) {
	t.Setenv("APP_ENV", "")
	t.Setenv("DATABASE_DRIVER", DriverSQLite)
	t.Setenv("DATABASE_DSN", "file:test.db")
	t.Setenv("SECURITY_GRPC_ADDR", "127.0.0.1:9001")

	_, err := Load()
	require.Error(t, err)
	require.Contains(t, err.Error(), "APP_ENV")
}

func TestLoadRejectsUnknownDriver(t *testing.T) {
	setValidEnv(t)
	t.Setenv("DATABASE_DRIVER", "oracle")

	_, err := Load()
	require.Error(t, err)

	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_database_driver", cfgErr.Code)
}

func TestLoadDefaults(t *testing.T) {
	setValidEnv(t)

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "127.0.0.1:8080", cfg.HTTPAddr)
	require.Equal(t, EnvTest, cfg.AppEnv)
	require.Equal(t, DriverSQLite, cfg.DatabaseDriver)
}

func TestLoadServerResourceDefaults(t *testing.T) {
	setValidEnv(t)

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 30*time.Second, cfg.HTTPReadTimeout)
	require.Equal(t, 120*time.Second, cfg.HTTPIdleTimeout)
	require.Zero(t, cfg.DBMaxOpenConns)
	require.Zero(t, cfg.DBMaxIdleConns)
	require.Equal(t, 30*time.Minute, cfg.DBConnMaxLifetime)
}

func TestLoadServerResourceOverrides(t *testing.T) {
	setValidEnv(t)
	t.Setenv("HTTP_READ_TIMEOUT_SECONDS", "45")
	t.Setenv("HTTP_IDLE_TIMEOUT_SECONDS", "90")
	t.Setenv("DB_MAX_OPEN_CONNS", "12")
	t.Setenv("DB_MAX_IDLE_CONNS", "6")
	t.Setenv("DB_CONN_MAX_LIFETIME_SECONDS", "600")

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 45*time.Second, cfg.HTTPReadTimeout)
	require.Equal(t, 90*time.Second, cfg.HTTPIdleTimeout)
	require.Equal(t, 12, cfg.DBMaxOpenConns)
	require.Equal(t, 6, cfg.DBMaxIdleConns)
	require.Equal(t, 10*time.Minute, cfg.DBConnMaxLifetime)
}

func TestLoadRejectsInvalidServerResourceLimits(t *testing.T) {
	cases := map[string]string{
		"HTTP_READ_TIMEOUT_SECONDS":    "0",
		"HTTP_IDLE_TIMEOUT_SECONDS":    "4000",
		"DB_MAX_OPEN_CONNS":            "-1",
		"DB_MAX_IDLE_CONNS":            "999",
		"DB_CONN_MAX_LIFETIME_SECONDS": "-5",
	}
	for key, value := range cases {
		t.Run(key, func(t *testing.T) {
			setValidEnv(t)
			t.Setenv(key, value)
			_, err := Load()
			require.Error(t, err)
		})
	}

	setValidEnv(t)
	t.Setenv("DB_MAX_OPEN_CONNS", "4")
	t.Setenv("DB_MAX_IDLE_CONNS", "8")
	_, err := Load()
	require.Error(t, err)
	require.Contains(t, err.Error(), "DB_MAX_IDLE_CONNS")
}

func TestLoadRequiresDSN(t *testing.T) {
	setValidEnv(t)
	t.Setenv("DATABASE_DSN", "")

	_, err := Load()
	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "missing_database_dsn", cfgErr.Code)
}

func TestLoadRequiresSecurityAddr(t *testing.T) {
	setValidEnv(t)
	t.Setenv("SECURITY_GRPC_ADDR", "")

	_, err := Load()
	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "missing_security_grpc_addr", cfgErr.Code)
}

func TestNormalizeDriver(t *testing.T) {
	cases := map[string]string{
		"sqlite":      DriverSQLite,
		" SQLite ":    DriverSQLite,
		"MYSQL":       DriverMySQL,
		"postgresql":  DriverPostgres,
		" PostgreSQL": DriverPostgres,
		"pg":          DriverPostgres,
	}
	for in, want := range cases {
		got, ok := NormalizeDriver(in)
		require.True(t, ok, in)
		require.Equal(t, want, got, in)
	}

	for _, in := range []string{"oracle", "sqlserver", "", "  "} {
		_, ok := NormalizeDriver(in)
		require.False(t, ok, in)
	}
}

func TestErrorAsConfigError(t *testing.T) {
	err := error(&Error{Code: "x", Detail: "y"})
	var cfgErr *Error
	require.True(t, errors.As(err, &cfgErr))
}

func TestMailIsOptional(t *testing.T) {
	setValidEnv(t)

	cfg, err := Load()
	require.NoError(t, err)
	require.Empty(t, cfg.SMTPHost, "mail must stay off unless SMTP_HOST is set")
	require.Empty(t, cfg.SMTPEncryption)
}

func TestMailDefaultsToStartTLS(t *testing.T) {
	setValidEnv(t)
	t.Setenv("SMTP_HOST", "smtp.example.com")
	t.Setenv("SMTP_FROM", "noreply@example.com")

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, SMTPEncryptionStartTLS, cfg.SMTPEncryption)
	require.Equal(t, 587, cfg.SMTPPort)
}

func TestMailPortDefaultsFollowEncryption(t *testing.T) {
	setValidEnv(t)
	t.Setenv("SMTP_HOST", "smtp.example.com")
	t.Setenv("SMTP_FROM", "noreply@example.com")

	t.Setenv("SMTP_ENCRYPTION", "ssl")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 465, cfg.SMTPPort)

	t.Setenv("SMTP_ENCRYPTION", "none")
	cfg, err = Load()
	require.NoError(t, err)
	require.Equal(t, 25, cfg.SMTPPort)
}

func TestMailFromFallsBackToUsername(t *testing.T) {
	setValidEnv(t)
	t.Setenv("SMTP_HOST", "smtp.example.com")
	t.Setenv("SMTP_USERNAME", "noreply@example.com")
	t.Setenv("SMTP_PASSWORD", "secret")

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "noreply@example.com", cfg.SMTPFrom)
	require.Equal(t, "Practacu Press", cfg.SMTPFromName)
}

func TestMailRejectsIncompleteCredentials(t *testing.T) {
	setValidEnv(t)
	t.Setenv("SMTP_HOST", "smtp.example.com")
	t.Setenv("SMTP_FROM", "noreply@example.com")
	t.Setenv("SMTP_USERNAME", "noreply@example.com")

	_, err := Load()
	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "incomplete_smtp_credentials", cfgErr.Code)
}

func TestMailRejectsPlaintextCredentialsOffLoopback(t *testing.T) {
	setValidEnv(t)
	t.Setenv("SMTP_HOST", "smtp.example.com")
	t.Setenv("SMTP_FROM", "noreply@example.com")
	t.Setenv("SMTP_USERNAME", "noreply@example.com")
	t.Setenv("SMTP_PASSWORD", "secret")
	t.Setenv("SMTP_ENCRYPTION", "none")

	_, err := Load()
	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "insecure_smtp_auth", cfgErr.Code)

	// A loopback relay is the one place where plaintext credentials are acceptable.
	t.Setenv("SMTP_HOST", "127.0.0.1")
	_, err = Load()
	require.NoError(t, err)
}

func TestMailRejectsBadEncryptionAndSender(t *testing.T) {
	setValidEnv(t)
	t.Setenv("SMTP_HOST", "smtp.example.com")
	t.Setenv("SMTP_FROM", "noreply@example.com")

	t.Setenv("SMTP_ENCRYPTION", "rot13")
	_, err := Load()
	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_smtp_encryption", cfgErr.Code)

	t.Setenv("SMTP_ENCRYPTION", "starttls")
	t.Setenv("SMTP_FROM", "Practacu <noreply@example.com>")
	_, err = Load()
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_smtp_from", cfgErr.Code)

	t.Setenv("SMTP_FROM", "")
	t.Setenv("SMTP_USERNAME", "")
	_, err = Load()
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "missing_smtp_from", cfgErr.Code)
}

func TestPublicBaseURLMustBeAbsolute(t *testing.T) {
	setValidEnv(t)

	t.Setenv("PUBLIC_BASE_URL", "https://press.example.com/")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "https://press.example.com", cfg.PublicBaseURL)

	t.Setenv("PUBLIC_BASE_URL", "press.example.com")
	_, err = Load()
	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_public_base_url", cfgErr.Code)

	t.Setenv("PUBLIC_BASE_URL", "ftp://press.example.com")
	_, err = Load()
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_public_base_url", cfgErr.Code)
}

func TestLoadRejectsNetworkFacingListen(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:8080", ":8080", "192.168.1.10:8080", "press.local:8080"} {
		t.Run(addr, func(t *testing.T) {
			setValidEnv(t)
			t.Setenv("HTTP_ADDR", addr)

			_, err := Load()
			require.Error(t, err)

			var cfgErr *Error
			require.ErrorAs(t, err, &cfgErr)
			require.Equal(t, "non_loopback_listen", cfgErr.Code)
		})
	}
}

func TestLoadAcceptsLoopbackListen(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:8080", "localhost:8080", "[::1]:8080"} {
		t.Run(addr, func(t *testing.T) {
			setValidEnv(t)
			t.Setenv("HTTP_ADDR", addr)

			cfg, err := Load()
			require.NoError(t, err)
			require.Equal(t, addr, cfg.HTTPAddr)
		})
	}
}

func TestLoadAllowsRemoteListenWithOptIn(t *testing.T) {
	setValidEnv(t)
	t.Setenv("HTTP_ADDR", "0.0.0.0:8080")
	t.Setenv("PP_ALLOW_REMOTE_API", "1")

	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "0.0.0.0:8080", cfg.HTTPAddr)
}

func TestLoadRejectsMalformedListen(t *testing.T) {
	setValidEnv(t)
	t.Setenv("HTTP_ADDR", "8080")

	_, err := Load()
	require.Error(t, err)

	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_http_addr", cfgErr.Code)
}

// --- per purpose media storage ---------------------------------------------

func TestLoadStorageScopesDefaultToInherit(t *testing.T) {
	setValidEnv(t)

	cfg, err := Load()
	require.NoError(t, err)

	for _, scope := range StorageScopeNames() {
		scoped, ok := cfg.StorageScopes[scope]
		require.True(t, ok, "scope %s must be parsed even when unset", scope)
		require.Equal(t, StorageDriverInherit, scoped.Driver)
		require.Empty(t, scoped.LocalDir)
		require.Empty(t, scoped.S3Bucket)
	}
}

func TestLoadStorageScopeLocalDefaultsToGlobalDir(t *testing.T) {
	setValidEnv(t)
	t.Setenv("STORAGE_DIR", "./data/media")
	t.Setenv("STORAGE_SITE_DRIVER", "local")
	t.Setenv("STORAGE_AVATAR_DRIVER", "local")
	t.Setenv("STORAGE_AVATAR_LOCAL_DIR", "./custom/avatars")

	cfg, err := Load()
	require.NoError(t, err)

	require.Equal(t, StorageDriverLocal, cfg.StorageScopes[StorageScopeSite].Driver)
	require.Equal(t, filepath.Join("./data/media", StorageScopeSite), cfg.StorageScopes[StorageScopeSite].LocalDir)
	require.Equal(t, "./custom/avatars", cfg.StorageScopes[StorageScopeAvatar].LocalDir)
}

func TestLoadStorageScopeS3RequiresBucket(t *testing.T) {
	setValidEnv(t)
	t.Setenv("STORAGE_ATTACHMENT_DRIVER", "s3")

	_, err := Load()
	require.Error(t, err)

	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "missing_scope_bucket", cfgErr.Code)
	require.Contains(t, cfgErr.Detail, "STORAGE_ATTACHMENT_S3_BUCKET")
}

func TestLoadStorageScopeS3DefaultsPrefixToGlobalPrefixAndScope(t *testing.T) {
	setValidEnv(t)
	t.Setenv("STORAGE_DRIVER", "local")
	t.Setenv("STORAGE_S3_REGION", "eu-west-1")
	t.Setenv("STORAGE_S3_PREFIX", "/tenant-a/")
	t.Setenv("STORAGE_CONTENT_DRIVER", "s3")
	t.Setenv("STORAGE_CONTENT_S3_BUCKET", "content-bucket")
	t.Setenv("STORAGE_SITE_DRIVER", "s3")
	t.Setenv("STORAGE_SITE_S3_BUCKET", "site-bucket")
	t.Setenv("STORAGE_SITE_S3_PREFIX", "custom/site")

	cfg, err := Load()
	require.NoError(t, err)

	// Connection settings are global and are read even when the global driver is
	// local, because a scope may select S3 on its own.
	require.Equal(t, "eu-west-1", cfg.S3Region)

	content := cfg.StorageScopes[StorageScopeContent]
	require.Equal(t, StorageDriverS3, content.Driver)
	require.Equal(t, "content-bucket", content.S3Bucket)
	require.Equal(t, "tenant-a/content", content.S3Prefix)

	site := cfg.StorageScopes[StorageScopeSite]
	require.Equal(t, "site-bucket", site.S3Bucket)
	require.Equal(t, "custom/site", site.S3Prefix, "an explicit scope prefix wins")
}

func TestLoadStorageScopeRejectsUnknownDriver(t *testing.T) {
	setValidEnv(t)
	t.Setenv("STORAGE_SITE_DRIVER", "ftp")

	_, err := Load()
	require.Error(t, err)

	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_storage_driver", cfgErr.Code)
	require.Contains(t, cfgErr.Detail, "STORAGE_SITE_DRIVER")
}
