// Package config loads and validates the process configuration from environment
// variables.
//
// Load fails fast: a missing or malformed required value is a startup error, never
// a silent default. Only values that are safe to default (such as the HTTP listen
// address) have one.
package config

import (
	"os"
	"strings"
)

// Accepted APP_ENV values.
const (
	EnvDevelopment = "development"
	EnvTest        = "test"
	EnvProduction  = "production"
)

// Canonical DATABASE_DRIVER values. NormalizeDriver also accepts aliases.
const (
	DriverSQLite   = "sqlite"
	DriverMySQL    = "mysql"
	DriverPostgres = "postgres"
)

// Config is the fully validated process configuration.
type Config struct {
	// AppEnv selects runtime strictness. One of development, test, production.
	AppEnv string
	// HTTPAddr is the listen address, for example "127.0.0.1:8080".
	HTTPAddr string
	// DatabaseDriver is the canonical driver name: sqlite, mysql or postgres.
	DatabaseDriver string
	// DatabaseDSN is passed to the driver untouched.
	DatabaseDSN string
	// SecurityGRPCAddr is the Rust security service gRPC endpoint.
	SecurityGRPCAddr string
}

// Error is a typed configuration error.
//
// Code is stable and safe to expose to operators and logs; Detail explains the
// offending value without echoing secrets.
type Error struct {
	Code   string
	Detail string
}

// Error implements the error interface.
func (e *Error) Error() string { return e.Code + ": " + e.Detail }

// Load reads the environment, validates it and returns a Config.
func Load() (Config, error) {
	cfg := Config{
		AppEnv:           env("APP_ENV"),
		HTTPAddr:         env("HTTP_ADDR"),
		DatabaseDriver:   env("DATABASE_DRIVER"),
		DatabaseDSN:      env("DATABASE_DSN"),
		SecurityGRPCAddr: env("SECURITY_GRPC_ADDR"),
	}

	switch cfg.AppEnv {
	case "":
		return Config{}, &Error{Code: "missing_app_env", Detail: "APP_ENV is required"}
	case EnvDevelopment, EnvTest, EnvProduction:
	default:
		return Config{}, &Error{
			Code:   "invalid_app_env",
			Detail: "APP_ENV must be one of development, test, production",
		}
	}

	if cfg.HTTPAddr == "" {
		cfg.HTTPAddr = "127.0.0.1:8080"
	}

	driver, ok := NormalizeDriver(cfg.DatabaseDriver)
	if !ok {
		return Config{}, &Error{
			Code:   "invalid_database_driver",
			Detail: "DATABASE_DRIVER must be one of sqlite, mysql, postgres",
		}
	}
	cfg.DatabaseDriver = driver

	if cfg.DatabaseDSN == "" {
		return Config{}, &Error{Code: "missing_database_dsn", Detail: "DATABASE_DSN is required"}
	}

	if cfg.SecurityGRPCAddr == "" {
		return Config{}, &Error{
			Code:   "missing_security_grpc_addr",
			Detail: "SECURITY_GRPC_ADDR is required",
		}
	}

	return cfg, nil
}

// NormalizeDriver maps a user supplied driver name to its canonical form.
//
// The comparison is case and whitespace insensitive, and "postgresql" is an
// accepted alias for "postgres". It is the single source of truth: the data
// layer delegates to it.
func NormalizeDriver(name string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case DriverSQLite:
		return DriverSQLite, true
	case DriverMySQL:
		return DriverMySQL, true
	case DriverPostgres, "postgresql", "pg":
		return DriverPostgres, true
	default:
		return "", false
	}
}

func env(key string) string { return strings.TrimSpace(os.Getenv(key)) }
