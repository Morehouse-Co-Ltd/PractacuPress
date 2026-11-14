// Package config loads and validates the process configuration from environment
// variables.
//
// Load fails fast: a missing or malformed required value is a startup error, never
// a silent default. Only values that are safe to default (such as the HTTP listen
// address) have one.
package config

import (
	"net"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
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

// Per purpose storage drivers. "inherit" reuses the global adapter.
const (
	StorageDriverInherit = "inherit"
	StorageDriverLocal   = "local"
	StorageDriverS3      = "s3"
)

// Storage scopes are the media purposes that may override global storage. They map
// one to one onto the media.Purpose values and name the STORAGE_<SCOPE>_* env group.
const (
	StorageScopeContent    = "content"
	StorageScopeSite       = "site"
	StorageScopeAvatar     = "avatar"
	StorageScopeAttachment = "attachment"
)

// StorageScopeNames lists every configurable scope.
func StorageScopeNames() []string {
	return []string{
		StorageScopeContent,
		StorageScopeSite,
		StorageScopeAvatar,
		StorageScopeAttachment,
	}
}

// StorageScopeConfig is the per purpose storage override parsed from
// STORAGE_<SCOPE>_*.
//
// The S3 endpoint, region and credentials always come from the global STORAGE_S3_*
// settings; a scope only chooses the driver, and for S3 its bucket and prefix.
type StorageScopeConfig struct {
	// Driver is one of inherit, local or s3.
	Driver string
	// LocalDir is the local root when Driver is local. It defaults to
	// <StorageDir>/<scope>.
	LocalDir string
	// S3Bucket is the target bucket when Driver is s3. Required in that case.
	S3Bucket string
	// S3Prefix is the key prefix when Driver is s3. It defaults to
	// <global S3 prefix>/<scope>.
	S3Prefix string
}

// CaptchaConfig is the server side human verification configuration.
//
// Only the secret lives here. Whether a site *wants* a challenge is site data (it
// is part of the stored design document), because it changes from the settings page
// without a redeploy; a deployment operator only supplies the credentials that make
// the choice enforceable.
//
// The URL overrides exist for two honest reasons: the test suite points them at an
// httptest server, and a deployment behind an egress proxy can route through a
// gateway it controls. They are empty in production.
//
// The built-in local provider needs neither a secret nor a URL: it is always
// available in the API process.
type CaptchaConfig struct {
	TurnstileSecret string
	HCaptchaSecret  string
	TurnstileURL    string
	HCaptchaURL     string
	Timeout         time.Duration
}

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
	// CredentialRateLimitPerMinute caps authentication attempts per client per
	// minute. It is a second, much tighter budget on top of RateLimitPerMinute,
	// because registration, login and password reset are the endpoints worth brute
	// forcing and each attempt costs one Argon2 hash. Zero disables the tier.
	CredentialRateLimitPerMinute int
	// MediaDefaultUserQuotaBytes and MediaDefaultSiteQuotaBytes are deployment-wide
	// upload storage limits. Zero means unlimited; site/member overrides may replace
	// these defaults independently.
	MediaDefaultUserQuotaBytes int64
	MediaDefaultSiteQuotaBytes int64
	// HTTPReadTimeout bounds how long a request may take to arrive. It protects the
	// server from slow clients holding connections open.
	HTTPReadTimeout time.Duration
	// HTTPIdleTimeout keeps idle keep-alive connections around. A shorter value
	// frees resources sooner; too short makes browsers reconnect constantly.
	HTTPIdleTimeout time.Duration
	// MaxRequestBodyBytes caps how much of a request body any handler may read. Zero
	// disables the cap. Media upload routes get their own, larger ceiling.
	MaxRequestBodyBytes int64
	// HTTPRequestTimeout bounds one request's work. It cancels the request context, so
	// a slow database call or a stuck upstream cannot hold a handler (and its
	// connection) forever. Streaming responses (downloads, the WebSocket upgrade) are
	// exempt because a deadline there would cut a legitimate slow transfer.
	HTTPRequestTimeout time.Duration
	// DBMaxOpenConns and DBMaxIdleConns override the driver defaults. Zero keeps
	// the defaults chosen by the data layer (SQLite 1, MySQL/Postgres 25).
	DBMaxOpenConns int
	DBMaxIdleConns int
	// DBConnMaxLifetime recycles pooled connections. Zero disables recycling.
	DBConnMaxLifetime time.Duration

	// AuthJWTPrivateKey is the base64 PKCS#8 Ed25519 signing key. It is optional at
	// load time so development can run with an ephemeral key; production refuses to
	// start without it, which is enforced when the issuer is constructed.
	AuthJWTPrivateKey string
	// AuthJWTKeyID names the signing key so a rotation can be staged.
	AuthJWTKeyID string
	// AuthJWTIssuer is the expected "iss" claim.
	AuthJWTIssuer string

	// CookieSecure marks the refresh and CSRF cookies Secure. It defaults to true
	// in production, where the API is served over TLS.
	CookieSecure bool
	// CookieDomain optionally scopes the cookies to a parent domain.
	CookieDomain string
	// DefaultSiteID is used when host resolution is not configured, which is the
	// Windows single site deployment mode.
	DefaultSiteID string
	// DesktopMode enables the zero configuration bootstrap the Windows launcher
	// relies on: the schema is applied at startup, a single site is created when the
	// database is empty, and the first registered account owns it.
	DesktopMode bool
	// StorageDir is the local media storage root.
	StorageDir string
	// BackupDir holds generated backup packages and their metadata sidecars.
	BackupDir string
	// StorageDriver selects local or s3.
	StorageDriver string
	// S3 settings, used when StorageDriver is s3.
	S3Bucket    string
	S3Region    string
	S3Endpoint  string
	S3AccessKey string
	S3SecretKey string
	S3Prefix    string
	// StorageScopes optionally overrides the adapter per media purpose. A scope with
	// no override (or driver inherit) reuses the global adapter above.
	StorageScopes map[string]StorageScopeConfig

	// SMTPHost is the outbound mail relay. Empty disables mail entirely, which is
	// also what turns password reset off: without a way to deliver the link the
	// endpoint would only ever lie to the caller.
	SMTPHost string
	// SMTPPort is the relay port. Defaults to 465 for ssl, 587 for starttls and 25
	// for none.
	SMTPPort int
	// SMTPEncryption is one of ssl, starttls or none.
	SMTPEncryption string
	// SMTPUsername and SMTPPassword authenticate the relay. Both are optional for
	// relays that accept unauthenticated mail from a trusted network.
	SMTPUsername string
	SMTPPassword string
	// SMTPFrom is the envelope and header sender. It defaults to SMTPUsername,
	// because most relays reject a sender they cannot authenticate for.
	SMTPFrom string
	// SMTPFromName is the display name of the sender.
	SMTPFromName string
	// PublicBaseURL overrides the origin used to build password reset links. Empty
	// means the origin of the request that asked for the reset is used, which is
	// correct for the same origin deployment this product ships.
	PublicBaseURL string

	// Captcha holds the human verification credentials. A provider without a
	// secret is reported as unenforced instead of silently accepting every token.
	Captcha CaptchaConfig

	// AuthOAuth holds the third party login client registrations, keyed by the
	// provider id the API exposes ("google", "github", "wechat"). A provider whose
	// client credentials are missing is reported as not configured: its buttons are
	// hidden and its endpoints answer `provider_not_configured`, rather than half
	// starting a flow that can only fail at the provider.
	AuthOAuth map[string]OAuthProviderConfig
	// AuthSMS describes the short message gateway used by phone code login. An
	// unconfigured gateway disables phone login instead of accepting codes nobody
	// can receive.
	AuthSMS SMSConfig
}

// OAuthProviderConfig is one provider's OAuth client registration.
//
// Secrets live only here: they are never persisted in the site configuration
// document or handed to a browser.
type OAuthProviderConfig struct {
	ClientID     string
	ClientSecret string
	// RedirectURI is the exact callback registered with the provider. Empty means
	// it is derived from the request origin at start time, which is correct for the
	// single origin deployment this product ships.
	RedirectURI string
	// Scope overrides the provider default.
	Scope string
}

// Configured reports whether the provider can complete a flow at all.
func (c OAuthProviderConfig) Configured() bool {
	return c.ClientID != "" && c.ClientSecret != ""
}

// SMS gateway provider names accepted by AUTH_SMS_PROVIDER.
const (
	// SMSProviderLog writes the code to the process log. It is development only:
	// a production install must configure a real gateway.
	SMSProviderLog = "log"
	// SMSProviderHTTP posts the code to a generic JSON gateway (AUTH_SMS_ENDPOINT).
	SMSProviderHTTP = "http"
)

// SMSConfig is the short message gateway configuration.
type SMSConfig struct {
	// Provider is one of the SMSProvider* values. Empty means "no gateway", which
	// disables phone login in production and falls back to the log sender in
	// development.
	Provider string
	// Endpoint is the gateway URL for the http provider.
	Endpoint string
	// AccessKeyID and AccessKeySecret authenticate the gateway. The secret is only
	// ever sent in an Authorization header.
	AccessKeyID     string
	AccessKeySecret string
	// SignName is the sender signature the carrier shows, and TemplateCode the
	// registered message template.
	SignName     string
	TemplateCode string
	// Timeout bounds one delivery attempt.
	Timeout time.Duration
}

// Configured reports whether a real gateway is configured.
func (c SMSConfig) Configured() bool {
	switch c.Provider {
	case SMSProviderHTTP:
		return c.Endpoint != "" && c.AccessKeySecret != ""
	case SMSProviderLog:
		return true
	default:
		return false
	}
}

// Accepted SMTP_ENCRYPTION values.
const (
	// SMTPEncryptionSSL wraps the connection in TLS from the first byte (port 465).
	SMTPEncryptionSSL = "ssl"
	// SMTPEncryptionStartTLS upgrades a plaintext connection (port 587).
	SMTPEncryptionStartTLS = "starttls"
	// SMTPEncryptionNone is plaintext. It is only accepted for a loopback relay:
	// credentials over a network would be readable by anyone on the path.
	SMTPEncryptionNone = "none"
)

// DefaultJWTIssuer is the issuer used when AUTH_JWT_ISSUER is unset.
const DefaultJWTIssuer = "practacu-press"

// DefaultRateLimitPerMinute is the global per client budget.
const DefaultRateLimitPerMinute = 240

// DefaultCredentialRateLimitPerMinute is the per client budget for endpoints that
// consume a password. Each accepted attempt costs one Argon2 hash, so this tier exists
// to keep a credential stuffing run from saturating the hashing path.
const DefaultCredentialRateLimitPerMinute = 10

// Server resource defaults. They match the values the HTTP server and the data
// layer used before they became configurable.
const (
	DefaultHTTPReadTimeout   = 30 * time.Second
	DefaultHTTPIdleTimeout   = 120 * time.Second
	DefaultDBConnMaxLifetime = 30 * time.Minute
	maxConnectionsPerProcess = 512
	maxTimeoutSeconds        = 3600

	// DefaultHTTPRequestTimeout bounds one request's work. Thirty seconds is far more
	// than any endpoint here needs and far less than forever.
	DefaultHTTPRequestTimeout = 30 * time.Second
	// DefaultMaxRequestBodyBytes caps ordinary JSON bodies. The largest legitimate one
	// is a 200k character article source (the security service's own ceiling), which is
	// under a megabyte as UTF-8, so four is generous. Upload routes carry their own,
	// larger limit derived from the media module's attachment ceiling.
	DefaultMaxRequestBodyBytes = 4 << 20
	// DefaultMediaUserQuotaBytes caps accumulated media per member on fresh deployments.
	DefaultMediaUserQuotaBytes int64 = 512 << 20
	// DefaultMediaSiteQuotaBytes caps accumulated media per site on fresh deployments.
	DefaultMediaSiteQuotaBytes int64 = 10 << 30
	// maxRequestBodyBytes is the largest value an operator may configure.
	maxRequestBodyBytes = 64 << 20
)

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

	// The API is meant to be reached only from this machine: the desktop launcher
	// proxies it under the same origin, so there is no reason to expose the port to
	// the LAN. A wildcard or LAN address is usually a typo or an accidental exposure,
	// therefore it fails fast unless the operator opts in explicitly.
	if problem := loopbackListenProblem(cfg.HTTPAddr); problem != nil && !envBool("PP_ALLOW_REMOTE_API") {
		return Config{}, problem
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

	// Credential endpoints get their own budget. The default is deliberately low: ten
	// password attempts per minute per client is far more than a human needs and far
	// less than a brute force run wants.
	credentialRate, err := envInt("AUTH_CREDENTIAL_RATE_LIMIT_PER_MINUTE", DefaultCredentialRateLimitPerMinute)
	if err != nil {
		return Config{}, err
	}
	if credentialRate < 0 || credentialRate > maxTimeoutSeconds {
		return Config{}, &Error{
			Code:   "invalid_credential_rate_limit",
			Detail: "AUTH_CREDENTIAL_RATE_LIMIT_PER_MINUTE must be between 0 and 3600",
		}
	}
	cfg.CredentialRateLimitPerMinute = credentialRate

	userQuota, err := envInt64("MEDIA_DEFAULT_USER_QUOTA_BYTES", DefaultMediaUserQuotaBytes)
	if err != nil {
		return Config{}, err
	}
	if userQuota < 0 {
		return Config{}, &Error{
			Code:   "invalid_media_default_user_quota_bytes",
			Detail: "MEDIA_DEFAULT_USER_QUOTA_BYTES must not be negative",
		}
	}
	siteQuota, err := envInt64("MEDIA_DEFAULT_SITE_QUOTA_BYTES", DefaultMediaSiteQuotaBytes)
	if err != nil {
		return Config{}, err
	}
	if siteQuota < 0 {
		return Config{}, &Error{
			Code:   "invalid_media_default_site_quota_bytes",
			Detail: "MEDIA_DEFAULT_SITE_QUOTA_BYTES must not be negative",
		}
	}
	cfg.MediaDefaultUserQuotaBytes = userQuota
	cfg.MediaDefaultSiteQuotaBytes = siteQuota

	readTimeout, err := envInt("HTTP_READ_TIMEOUT_SECONDS", int(DefaultHTTPReadTimeout/time.Second))
	if err != nil {
		return Config{}, err
	}
	if readTimeout < 1 || readTimeout > maxTimeoutSeconds {
		return Config{}, &Error{
			Code:   "invalid_http_read_timeout",
			Detail: "HTTP_READ_TIMEOUT_SECONDS must be between 1 and 3600",
		}
	}
	cfg.HTTPReadTimeout = time.Duration(readTimeout) * time.Second

	idleTimeout, err := envInt("HTTP_IDLE_TIMEOUT_SECONDS", int(DefaultHTTPIdleTimeout/time.Second))
	if err != nil {
		return Config{}, err
	}
	if idleTimeout < 1 || idleTimeout > maxTimeoutSeconds {
		return Config{}, &Error{
			Code:   "invalid_http_idle_timeout",
			Detail: "HTTP_IDLE_TIMEOUT_SECONDS must be between 1 and 3600",
		}
	}
	cfg.HTTPIdleTimeout = time.Duration(idleTimeout) * time.Second

	requestTimeout, err := envInt("HTTP_REQUEST_TIMEOUT_SECONDS", int(DefaultHTTPRequestTimeout/time.Second))
	if err != nil {
		return Config{}, err
	}
	if requestTimeout < 0 || requestTimeout > maxTimeoutSeconds {
		return Config{}, &Error{
			Code:   "invalid_http_request_timeout",
			Detail: "HTTP_REQUEST_TIMEOUT_SECONDS must be between 0 and 3600",
		}
	}
	cfg.HTTPRequestTimeout = time.Duration(requestTimeout) * time.Second

	bodyLimit, err := envInt("MAX_REQUEST_BODY_BYTES", DefaultMaxRequestBodyBytes)
	if err != nil {
		return Config{}, err
	}
	if bodyLimit < 0 || bodyLimit > maxRequestBodyBytes {
		return Config{}, &Error{
			Code:   "invalid_max_request_body_bytes",
			Detail: "MAX_REQUEST_BODY_BYTES must be between 0 and 67108864",
		}
	}
	cfg.MaxRequestBodyBytes = int64(bodyLimit)

	for key, target := range map[string]*int{
		"DB_MAX_OPEN_CONNS": &cfg.DBMaxOpenConns,
		"DB_MAX_IDLE_CONNS": &cfg.DBMaxIdleConns,
	} {
		value, err := envInt(key, 0)
		if err != nil {
			return Config{}, err
		}
		if value < 0 || value > maxConnectionsPerProcess {
			return Config{}, &Error{
				Code:   "invalid_" + strings.ToLower(key),
				Detail: key + " must be between 0 and 512",
			}
		}
		*target = value
	}
	if cfg.DBMaxOpenConns > 0 && cfg.DBMaxIdleConns > cfg.DBMaxOpenConns {
		return Config{}, &Error{
			Code:   "invalid_db_pool",
			Detail: "DB_MAX_IDLE_CONNS must not exceed DB_MAX_OPEN_CONNS",
		}
	}

	lifetime, err := envInt(
		"DB_CONN_MAX_LIFETIME_SECONDS",
		int(DefaultDBConnMaxLifetime/time.Second),
	)
	if err != nil {
		return Config{}, err
	}
	if lifetime < 0 || lifetime > 24*60*60 {
		return Config{}, &Error{
			Code:   "invalid_db_conn_max_lifetime",
			Detail: "DB_CONN_MAX_LIFETIME_SECONDS must be between 0 and 86400",
		}
	}
	cfg.DBConnMaxLifetime = time.Duration(lifetime) * time.Second

	cfg.AuthJWTPrivateKey = env("AUTH_JWT_ED25519_PRIVATE_KEY")
	cfg.AuthJWTKeyID = env("AUTH_JWT_KID")
	cfg.AuthJWTIssuer = env("AUTH_JWT_ISSUER")
	if cfg.AuthJWTIssuer == "" {
		cfg.AuthJWTIssuer = DefaultJWTIssuer
	}

	cfg.StorageDir = env("STORAGE_DIR")
	if cfg.StorageDir == "" {
		cfg.StorageDir = "./data/media"
	}

	cfg.BackupDir = env("BACKUP_DIR")
	if cfg.BackupDir == "" {
		cfg.BackupDir = "./data/backups"
	}

	// The S3 connection settings are read regardless of the global driver: a per
	// purpose override may select S3 while the global driver stays local, and it
	// reuses these credentials, endpoint, region and prefix.
	cfg.S3Bucket = env("STORAGE_S3_BUCKET")
	cfg.S3Region = env("STORAGE_S3_REGION")
	cfg.S3Endpoint = env("STORAGE_S3_ENDPOINT")
	cfg.S3AccessKey = env("STORAGE_S3_ACCESS_KEY")
	cfg.S3SecretKey = env("STORAGE_S3_SECRET_KEY")
	cfg.S3Prefix = env("STORAGE_S3_PREFIX")

	cfg.StorageDriver = env("STORAGE_DRIVER")
	if cfg.StorageDriver == "" {
		cfg.StorageDriver = "local"
	}
	switch cfg.StorageDriver {
	case "local":
	case "s3":
		if cfg.S3Bucket == "" {
			return Config{}, &Error{
				Code:   "missing_s3_bucket",
				Detail: "STORAGE_S3_BUCKET is required when STORAGE_DRIVER=s3",
			}
		}
	default:
		return Config{}, &Error{
			Code:   "invalid_storage_driver",
			Detail: "STORAGE_DRIVER must be local or s3",
		}
	}

	if err := loadStorageScopes(&cfg); err != nil {
		return Config{}, err
	}

	cfg.CookieDomain = env("COOKIE_DOMAIN")
	cfg.DefaultSiteID = env("DEFAULT_SITE_ID")
	cfg.DesktopMode = envBool("PP_DESKTOP")
	if cfg.DesktopMode && cfg.AppEnv == EnvProduction {
		// The desktop bootstrap seeds a site and promotes the first account. That is
		// a convenience for a loopback install, never something a public deployment
		// should be able to switch on by accident.
		return Config{}, &Error{
			Code:   "invalid_desktop_mode",
			Detail: "PP_DESKTOP cannot be enabled when APP_ENV=production",
		}
	}
	if raw := env("COOKIE_SECURE"); raw != "" {
		cfg.CookieSecure = envBool("COOKIE_SECURE")
	} else {
		cfg.CookieSecure = cfg.AppEnv == EnvProduction
	}

	if err := loadMail(&cfg); err != nil {
		return Config{}, err
	}
	cfg.PublicBaseURL = strings.TrimRight(env("PUBLIC_BASE_URL"), "/")
	if cfg.PublicBaseURL != "" {
		parsed, err := url.Parse(cfg.PublicBaseURL)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			// A bare "press.example.com" would end up in a mail as a relative link,
			// which is silently useless.
			return Config{}, &Error{
				Code:   "invalid_public_base_url",
				Detail: "PUBLIC_BASE_URL must be an absolute http or https URL",
			}
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return Config{}, &Error{
				Code:   "invalid_public_base_url",
				Detail: "PUBLIC_BASE_URL must use http or https",
			}
		}
	}
	// Mail links are one-time credentials. Without a configured public origin the
	// auth layer would fall back to the request Host header, which an attacker can
	// influence (password reset / email verification link poisoning). Require the
	// operator to pin the origin instead of silently trusting Host once SMTP is on.
	// Desktop installs are loopback-only and keep the request-origin fallback.
	if cfg.SMTPHost != "" && cfg.PublicBaseURL == "" && !cfg.DesktopMode {
		return Config{}, &Error{
			Code: "invalid_public_base_url",
			Detail: "PUBLIC_BASE_URL is required when SMTP is configured, so reset and " +
				"verification links cannot be pointed at a forged Host header",
		}
	}

	if err := loadCaptcha(&cfg); err != nil {
		return Config{}, err
	}

	if err := loadAuthProviders(&cfg); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

// oauthProviders are the third party login providers the API understands.
//
// The list is the allow-list: a provider that is not named here cannot be started
// even if an environment variable happens to be set, so a typo cannot widen the
// attack surface.
var oauthProviders = []string{"google", "github", "wechat"}

// loadAuthProviders reads the OAuth client registrations and the SMS gateway.
//
// Everything here is optional: an install that only offers email and password
// simply has no credentials, and the login page reports the missing providers
// instead of showing buttons that cannot work.
func loadAuthProviders(cfg *Config) error {
	cfg.AuthOAuth = make(map[string]OAuthProviderConfig, len(oauthProviders))
	for _, id := range oauthProviders {
		prefix := "AUTH_" + strings.ToUpper(id) + "_"
		provider := OAuthProviderConfig{
			ClientID:     env(prefix + "CLIENT_ID"),
			ClientSecret: env(prefix + "CLIENT_SECRET"),
			RedirectURI:  env(prefix + "REDIRECT_URI"),
			Scope:        env(prefix + "SCOPE"),
		}
		// WeChat names the client pair AppID/AppSecret; accept both spellings so an
		// operator copying the console label does not end up with a half configured
		// provider.
		if id == "wechat" {
			if provider.ClientID == "" {
				provider.ClientID = env("AUTH_WECHAT_APP_ID")
			}
			if provider.ClientSecret == "" {
				provider.ClientSecret = env("AUTH_WECHAT_APP_SECRET")
			}
		}
		if (provider.ClientID == "") != (provider.ClientSecret == "") {
			return &Error{
				Code:   "incomplete_oauth_credentials",
				Detail: prefix + "CLIENT_ID and " + prefix + "CLIENT_SECRET must be set together",
			}
		}
		if provider.RedirectURI != "" {
			parsed, err := url.Parse(provider.RedirectURI)
			if err != nil || parsed.Scheme == "" || parsed.Host == "" ||
				(parsed.Scheme != "http" && parsed.Scheme != "https") {
				return &Error{
					Code:   "invalid_oauth_redirect_uri",
					Detail: prefix + "REDIRECT_URI must be an absolute http or https URL",
				}
			}
		}
		cfg.AuthOAuth[id] = provider
	}

	cfg.AuthSMS = SMSConfig{
		Provider:        strings.ToLower(env("AUTH_SMS_PROVIDER")),
		Endpoint:        env("AUTH_SMS_ENDPOINT"),
		AccessKeyID:     env("AUTH_SMS_ACCESS_KEY_ID"),
		AccessKeySecret: env("AUTH_SMS_ACCESS_KEY_SECRET"),
		SignName:        env("AUTH_SMS_SIGN_NAME"),
		TemplateCode:    env("AUTH_SMS_TEMPLATE_CODE"),
		Timeout:         10 * time.Second,
	}
	switch cfg.AuthSMS.Provider {
	case "", SMSProviderLog, SMSProviderHTTP:
	default:
		return &Error{
			Code:   "invalid_sms_provider",
			Detail: "AUTH_SMS_PROVIDER must be one of log, http",
		}
	}
	if cfg.AuthSMS.Provider == SMSProviderHTTP {
		if cfg.AuthSMS.Endpoint == "" || cfg.AuthSMS.AccessKeySecret == "" {
			return &Error{
				Code: "incomplete_sms_gateway",
				Detail: "AUTH_SMS_ENDPOINT and AUTH_SMS_ACCESS_KEY_SECRET are required " +
					"when AUTH_SMS_PROVIDER=http",
			}
		}
		parsed, err := url.Parse(cfg.AuthSMS.Endpoint)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return &Error{
				Code:   "invalid_sms_endpoint",
				Detail: "AUTH_SMS_ENDPOINT must be an absolute http or https URL",
			}
		}
		if parsed.Scheme != "https" && !isLoopback(parsed.Hostname()) {
			// The request carries the access key secret; plaintext to a remote host
			// would hand it to anyone on the path.
			return &Error{
				Code:   "insecure_sms_endpoint",
				Detail: "AUTH_SMS_ENDPOINT must use https unless the gateway is on localhost",
			}
		}
	}
	return nil
}

// loadCaptcha reads the human verification credentials.
//
// The secrets are optional: a deployment without them serves sites with the
// captcha switch off, and a site that switched it on is reported as unenforced
// (with a warning log) instead of being silently accepted. The timeout is short
// because a challenge that takes longer than a login is a failed challenge.
func loadCaptcha(cfg *Config) error {
	cfg.Captcha = CaptchaConfig{
		TurnstileSecret: env("CAPTCHA_TURNSTILE_SECRET"),
		HCaptchaSecret:  env("CAPTCHA_HCAPTCHA_SECRET"),
		TurnstileURL:    env("CAPTCHA_TURNSTILE_URL"),
		HCaptchaURL:     env("CAPTCHA_HCAPTCHA_URL"),
	}

	timeout, err := envInt("CAPTCHA_TIMEOUT_SECONDS", 5)
	if err != nil {
		return err
	}
	if timeout < 1 || timeout > 30 {
		return &Error{
			Code:   "invalid_captcha_timeout_seconds",
			Detail: "CAPTCHA_TIMEOUT_SECONDS must be between 1 and 30",
		}
	}
	cfg.Captcha.Timeout = time.Duration(timeout) * time.Second
	return nil
}

// loadStorageScopes reads the optional per purpose storage overrides.
func loadStorageScopes(cfg *Config) error {
	names := StorageScopeNames()
	cfg.StorageScopes = make(map[string]StorageScopeConfig, len(names))
	for _, scope := range names {
		parsed, err := loadStorageScope(*cfg, scope)
		if err != nil {
			return err
		}
		cfg.StorageScopes[scope] = parsed
	}
	return nil
}

// loadStorageScope reads one STORAGE_<SCOPE>_* group.
func loadStorageScope(cfg Config, scope string) (StorageScopeConfig, error) {
	prefix := "STORAGE_" + strings.ToUpper(scope) + "_"

	driver := strings.ToLower(env(prefix + "DRIVER"))
	if driver == "" {
		driver = StorageDriverInherit
	}

	switch driver {
	case StorageDriverInherit:
		return StorageScopeConfig{Driver: StorageDriverInherit}, nil

	case StorageDriverLocal:
		dir := env(prefix + "LOCAL_DIR")
		if dir == "" {
			// Default to a scope subdirectory of the global root, so two purposes never
			// silently share one directory.
			dir = filepath.Join(cfg.StorageDir, scope)
		}
		return StorageScopeConfig{Driver: StorageDriverLocal, LocalDir: dir}, nil

	case StorageDriverS3:
		bucket := env(prefix + "S3_BUCKET")
		if bucket == "" {
			return StorageScopeConfig{}, &Error{
				Code:   "missing_scope_bucket",
				Detail: prefix + "S3_BUCKET is required when " + prefix + "DRIVER=s3",
			}
		}
		keyPrefix := env(prefix + "S3_PREFIX")
		if keyPrefix == "" {
			keyPrefix = joinStoragePrefix(cfg.S3Prefix, scope)
		}
		return StorageScopeConfig{
			Driver:   StorageDriverS3,
			S3Bucket: bucket,
			S3Prefix: keyPrefix,
		}, nil

	default:
		return StorageScopeConfig{}, &Error{
			Code:   "invalid_storage_driver",
			Detail: prefix + "DRIVER must be inherit, local or s3",
		}
	}
}

// joinStoragePrefix appends a scope segment to the global key prefix.
func joinStoragePrefix(base, scope string) string {
	base = strings.Trim(base, "/")
	if base == "" {
		return scope
	}
	return base + "/" + scope
}

// loadMail reads and validates the outbound mail settings.
//
// Mail stays entirely optional: an install that never needs password reset simply
// leaves SMTP_HOST empty and the feature reports itself as unavailable instead of
// accepting requests it cannot fulfil.
func loadMail(cfg *Config) error {
	cfg.SMTPHost = env("SMTP_HOST")
	if cfg.SMTPHost == "" {
		return nil
	}

	encryption := strings.ToLower(env("SMTP_ENCRYPTION"))
	switch encryption {
	case "":
		encryption = SMTPEncryptionStartTLS
	case SMTPEncryptionSSL, SMTPEncryptionStartTLS, SMTPEncryptionNone:
	default:
		return &Error{
			Code:   "invalid_smtp_encryption",
			Detail: "SMTP_ENCRYPTION must be one of ssl, starttls, none",
		}
	}
	cfg.SMTPEncryption = encryption

	defaultPort := 587
	switch encryption {
	case SMTPEncryptionSSL:
		defaultPort = 465
	case SMTPEncryptionNone:
		defaultPort = 25
	}
	port, err := envInt("SMTP_PORT", defaultPort)
	if err != nil {
		return err
	}
	if port < 1 || port > 65535 {
		return &Error{Code: "invalid_smtp_port", Detail: "SMTP_PORT must be between 1 and 65535"}
	}
	cfg.SMTPPort = port

	cfg.SMTPUsername = env("SMTP_USERNAME")
	cfg.SMTPPassword = env("SMTP_PASSWORD")
	if (cfg.SMTPUsername == "") != (cfg.SMTPPassword == "") {
		return &Error{
			Code:   "incomplete_smtp_credentials",
			Detail: "SMTP_USERNAME and SMTP_PASSWORD must be set together",
		}
	}
	if cfg.SMTPUsername != "" && encryption == SMTPEncryptionNone && !isLoopback(cfg.SMTPHost) {
		// PlainAuth refuses this too; failing at startup gives the operator the
		// reason instead of a mysterious delivery error on the first reset.
		return &Error{
			Code:   "insecure_smtp_auth",
			Detail: "SMTP credentials require ssl or starttls unless the relay is on localhost",
		}
	}

	cfg.SMTPFrom = env("SMTP_FROM")
	if cfg.SMTPFrom == "" {
		cfg.SMTPFrom = cfg.SMTPUsername
	}
	if cfg.SMTPFrom == "" {
		return &Error{Code: "missing_smtp_from", Detail: "SMTP_FROM is required when SMTP_HOST is set"}
	}
	if parsed, err := mail.ParseAddress(cfg.SMTPFrom); err != nil || parsed.Address != cfg.SMTPFrom {
		// The display name has its own variable (SMTP_FROM_NAME), so "Name <addr>"
		// here is almost always a paste mistake worth rejecting.
		return &Error{Code: "invalid_smtp_from", Detail: "SMTP_FROM must be a bare email address"}
	}
	cfg.SMTPFromName = env("SMTP_FROM_NAME")
	if cfg.SMTPFromName == "" {
		cfg.SMTPFromName = "Practacu Press"
	}
	return nil
}

// isLoopback reports whether host resolves to the local machine by name or literal.
func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
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

// envInt64 reads a signed 64-bit integer, falling back to def when unset. Callers
// validate whether negative values are meaningful for their setting.
func envInt64(key string, def int64) (int64, error) {
	raw := env(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, &Error{Code: "invalid_" + strings.ToLower(key), Detail: key + " must be a 64-bit integer"}
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

// loopbackListenProblem reports why addr would expose the API beyond this machine.
//
// An empty host (":8080"), "0.0.0.0" and a LAN address all mean "reachable from the
// network"; only 127.0.0.0/8, ::1 and the localhost name are accepted. The check is
// intentionally conservative: an unparseable hostname could resolve anywhere, so it
// is rejected too.
func loopbackListenProblem(addr string) *Error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return &Error{
			Code:   "invalid_http_addr",
			Detail: "HTTP_ADDR must look like host:port, for example 127.0.0.1:8080",
		}
	}
	host = strings.Trim(host, "[]")
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	return &Error{
		Code: "non_loopback_listen",
		Detail: "HTTP_ADDR must be a loopback address (127.0.0.1, ::1 or localhost), got " +
			addr + "; set PP_ALLOW_REMOTE_API=1 to allow a network-facing API",
	}
}
