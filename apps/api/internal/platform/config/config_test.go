package config

import (
	"errors"
	"testing"

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
