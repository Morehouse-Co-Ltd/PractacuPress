// Package config loads and validates the process configuration from environment
// variables.
//
// Load fails fast: a missing or malformed required value is a startup error, never
// a silent default. Only values that are safe to default (such as the HTTP listen
// address) have one.
package config

import (
	"os"
	"strconv"
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

	// CORSAllowedOrigins lists browser origins allowed to call the API. Empty
	// means cross origin browser access is disabled, which is the safe default.
	CORSAllowedOrigins []string
	// CORSCredentials allows cookies on cross origin requests. It requires an
	// explicit origin list; the wildcard is rejected when this is true.
	CORSCredentials bool
	// TrustedProxies lists CIDRs or IPs whose forwarding headers are believed.
	// Empty means no proxy is trusted and forwarding headers are ignored.
	TrustedProxies []string
	// RateLimitPerMinute caps requests per client per minute. Zero disables it.
	RateLimitPerMinute int

	// AuthJWTPrivateKey is the base64 PKCS#8 Ed25519 signing key. It is optional at
	// load time so development can run with an ephemeral key; production refuses to
	// start without it, which is enforced when the issuer is constructed.
	AuthJWTPrivateKey string
	// AuthJWTKeyID names the signing key so a rotation can be staged.
	AuthJWTKeyID string
	// AuthJWTIssuer is the expected "iss" claim.
	AuthJWTIssuer string
}

// DefaultJWTIssuer is the issuer used when AUTH_JWT_ISSUER is unset.
const DefaultJWTIssuer = "practacu-press"

// DefaultRateLimitPerMinute is the global per client budget.
const DefaultRateLimitPerMinute = 240

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

	cfg.CORSAllowedOrigins = envList("CORS_ALLOWED_ORIGINS")
	cfg.CORSCredentials = envBool("CORS_ALLOW_CREDENTIALS")
	cfg.TrustedProxies = envList("TRUSTED_PROXIES")

	// Credentials plus a wildcard origin is rejected by browsers and is a common
	// way to accidentally expose cookies to any site, so it fails at startup.
	if cfg.CORSCredentials {
		for _, origin := range cfg.CORSAllowedOrigins {
			if origin == "*" {
				return Config{}, &Error{
					Code:   "invalid_cors_origin",
					Detail: "CORS_ALLOW_CREDENTIALS cannot be combined with the * origin",
				}
			}
		}
	}

	rate, err := envInt("RATE_LIMIT_PER_MINUTE", DefaultRateLimitPerMinute)
	if err != nil {
		return Config{}, err
	}
	if rate < 0 {
		return Config{}, &Error{
			Code:   "invalid_rate_limit",
			Detail: "RATE_LIMIT_PER_MINUTE must not be negative",
		}
	}
	cfg.RateLimitPerMinute = rate

	cfg.AuthJWTPrivateKey = env("AUTH_JWT_ED25519_PRIVATE_KEY")
	cfg.AuthJWTKeyID = env("AUTH_JWT_KID")
	cfg.AuthJWTIssuer = env("AUTH_JWT_ISSUER")
	if cfg.AuthJWTIssuer == "" {
		cfg.AuthJWTIssuer = DefaultJWTIssuer
	}

	return cfg, nil
}

// envList reads a comma separated list, dropping empty entries.
func envList(key string) []string {
	raw := env(key)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// envBool reads a permissive boolean flag.
func envBool(key string) bool {
	switch strings.ToLower(env(key)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// envInt reads a non negative integer, falling back to def when unset.
func envInt(key string, def int) (int, error) {
	raw := env(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, &Error{Code: "invalid_" + strings.ToLower(key), Detail: key + " must be an integer"}
	}
	return n, nil
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
