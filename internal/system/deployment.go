package system

import (
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/config"
	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

// StorageScopeGlobal names the deployment wide storage row of DeploymentSnapshot.
const StorageScopeGlobal = "global"

// EffectiveStorage is one storage scope exactly as the media adapters use it.
//
// Only the values that select a location are reported. Access key, secret key and
// endpoint stay out on purpose: they identify credentials, and an operator who needs
// them reads the .env file on the server, not an API response.
type EffectiveStorage struct {
	// Scope is "global" or one of the media purpose scopes.
	Scope string `json:"scope"`
	// Driver is local or s3, already resolved: an inheriting purpose reports the
	// global driver instead of the literal "inherit".
	Driver string `json:"driver"`
	// LocalDir is the directory the driver writes to when Driver is local.
	LocalDir string `json:"local_dir"`
	// S3Bucket, S3Region and S3Prefix describe the target when Driver is s3.
	S3Bucket string `json:"s3_bucket"`
	S3Region string `json:"s3_region"`
	S3Prefix string `json:"s3_prefix"`
}

// EffectiveCORS is the cross origin policy the process enforces.
type EffectiveCORS struct {
	// AllowedOrigins is empty when cross origin browser access is disabled, which is
	// the safe default, so the field is always present as an array.
	AllowedOrigins []string `json:"allowed_origins"`
	// AllowCredentials decides whether a cross origin call may carry cookies.
	AllowCredentials bool `json:"allow_credentials"`
}

// EffectiveDomains is the request addressing part of the deployment settings.
type EffectiveDomains struct {
	// HTTPSOnly reports whether this API enforces HTTPS itself.
	//
	// It is always false, and that is the truth rather than a placeholder: the process
	// listens on plain HTTP by design (see the loopback rule in platform/config) and
	// TLS is terminated by whatever sits in front of it, usually a reverse proxy
	// or a reverse proxy. The `domains.https_only` switch in the site configuration
	// therefore cannot be applied here; the settings page has to say so instead of
	// showing the stored switch as if it were in force.
	HTTPSOnly bool `json:"https_only"`
	// PublicBaseURL is the pinned origin used for links in outbound mail. Empty means
	// the request origin is used, which only desktop installs are allowed to do.
	PublicBaseURL string `json:"public_base_url"`
	// TrustedProxies are the peers whose forwarding headers are believed.
	TrustedProxies []string `json:"trusted_proxies"`
}

// EffectiveMail describes the outbound relay. It carries no credential: a relay that
// needs authentication reports only that it is configured.
type EffectiveMail struct {
	// Configured is true when a relay is set up at all, which is also what enables
	// password reset and address verification.
	Configured bool `json:"configured"`
	// Encryption is ssl, starttls or none.
	Encryption string `json:"encryption"`
	// From is the bare envelope sender.
	From string `json:"from"`
}

// StorageRuntime is the live storage view supplied by the runtime manager.
//
// Rows are the resolved targets the media adapters would use for a new write;
// Live means the process can switch adapters without a restart.
type StorageRuntime struct {
	Rows      []EffectiveStorage
	Live      bool
	Source    string
	UpdatedAt *time.Time
}

// DeploymentSnapshot is the deployment configuration this process loaded at startup.
//
// It is read only by construction: nothing in the API can write an environment
// variable, which is the reason the settings pages need this endpoint at all.
type DeploymentSnapshot struct {
	Storage []EffectiveStorage `json:"storage"`
	CORS    EffectiveCORS      `json:"cors"`
	Domains EffectiveDomains   `json:"domains"`
	Mail    EffectiveMail      `json:"mail"`
	// StorageLive reports that the storage rows below come from the runtime manager
	// and can be changed from the dashboard without a restart.
	StorageLive bool `json:"storage_live"`
	// StorageSource is "saved" when data/storage-settings.json is in force and "env"
	// when the deployment variables are still the source.
	StorageSource string `json:"storage_source"`
	// StorageUpdatedAt is when the running document was applied; nil for .env.
	StorageUpdatedAt *time.Time `json:"storage_updated_at"`
	// RestartRequired tells the settings pages that the values stored in the site
	// configuration are not the ones this process runs with.
	//
	// It is reported as true unconditionally, and that is the honest answer rather than
	// a shortcut. The values below come from the process environment, which only a new
	// process can change. The values the pages store live in a per-site configuration
	// document, and one deployment serves several sites: a mismatch on any single site
	// still cannot be fixed by restarting the shared process, so a "false" would be a
	// promise this endpoint cannot keep. Comparing would also require resolving a site
	// and decoding its document on every poll of a deployment scoped panel. Until the
	// storage adapter and the TLS certificate can be reconfigured at runtime, the honest
	// message is "these values come from .env; edit it and restart".
	RestartRequired bool `json:"restart_required"`
	// CapturedAt is when this snapshot was built, so a panel can show how stale its
	// copy is after a restart.
	CapturedAt time.Time `json:"captured_at"`
}

// RoutesEffectiveConfig mounts the effective configuration endpoint under /api/v1.
//
// It is a separate registrar on purpose. The resource panel this package was built for
// is optional (PP_SYSTEM_METRICS) and needs a sampler, a background goroutine and
// gopsutil; the deployment settings surface needs none of that, only the Config the
// process already holds. Mounting them independently lets a deployment expose the
// settings values the admin pages read without running the sampler.
func (h *Handler) RoutesEffectiveConfig(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/system", requireAuth)
	group.GET("/effective-config", h.EffectiveConfig)
}

// EffectiveConfig returns the deployment settings the running process really uses.
//
// The settings pages write storage, CORS and domain values into the site configuration
// while the process keeps reading STORAGE_*, CORS_ALLOWED_ORIGINS, TRUSTED_PROXIES and
// SMTP_* from its environment, so an operator could change a value, see it saved, and
// change nothing at runtime. This endpoint is the missing half: it reports what is in
// force, so a page can show the stored intent next to the effective value and tell the
// operator which of the two a restart or a .env edit would move.
//
// Trust model: the payload names the local media directory, the proxy ranges that are
// believed and the mail sender. It is therefore limited to the site administrator, who
// owns the settings pages that read it, and the platform administrator, who owns the
// deployment. Everything below that role sees nothing.
func (h *Handler) EffectiveConfig(c *gin.Context) {
	role, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	// The authority ladder lives in the site package, so this cannot drift from the
	// membership guard that produced the role in the first place.
	if !site.Role(role).AtLeast(site.RoleSiteAdmin) {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "administrator_required"))
		return
	}
	if h.deployment == nil {
		// Fails closed: a guessed deployment setting is exactly the bug this endpoint
		// exists to end, so an unwired composition root answers "internal error".
		_ = c.Error(apperr.Internal(nil).WithDetail("reason", "deployment_config_unavailable"))
		return
	}

	snapshot := deploymentSnapshot(h.deployment(), time.Now().UTC())
	if h.storage != nil {
		runtime := h.storage()
		snapshot.Storage = runtime.Rows
		snapshot.StorageLive = runtime.Live
		snapshot.StorageSource = runtime.Source
		snapshot.StorageUpdatedAt = runtime.UpdatedAt
	}
	// The values change only when the process restarts, but caching them would hide
	// the one transition the panel exists to report, and the payload is tiny.
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, snapshot)
}

// deploymentSnapshot builds the view of cfg that the endpoint serves.
//
// It is pure so the resolution rules (which are the interesting part) can be tested
// without a process environment, a database or a running server.
func deploymentSnapshot(cfg config.Config, now time.Time) DeploymentSnapshot {
	return DeploymentSnapshot{
		Storage: effectiveStorage(cfg),
		CORS: EffectiveCORS{
			AllowedOrigins:   nonNilStrings(cfg.CORSAllowedOrigins),
			AllowCredentials: cfg.CORSCredentials,
		},
		Domains: EffectiveDomains{
			HTTPSOnly:      false,
			PublicBaseURL:  cfg.PublicBaseURL,
			TrustedProxies: nonNilStrings(cfg.TrustedProxies),
		},
		Mail: EffectiveMail{
			// An empty relay host is what disables mail (and with it the password
			// reset endpoint) in the rest of the API, so it is also what "configured"
			// means here.
			Configured: cfg.SMTPHost != "",
			Encryption: cfg.SMTPEncryption,
			From:       cfg.SMTPFrom,
		},
		StorageLive:     false,
		StorageSource:   "env",
		RestartRequired: true,
		CapturedAt:      now,
	}
}

// effectiveStorage resolves one row per scope, global first, to the values the media
// adapters were actually built from.
//
// The global row leads because every other row inherits from it. buildStorage in the
// composition root skips a purpose whose driver is unset or "inherit", which leaves that
// purpose served by the global adapter: its row therefore repeats the global values
// instead of showing empty strings. Reporting the empty strings would be the same lie
// as before, only in a new place.
func effectiveStorage(cfg config.Config) []EffectiveStorage {
	global := EffectiveStorage{Scope: StorageScopeGlobal, Driver: globalStorageDriver(cfg.StorageDriver)}
	if global.Driver == config.StorageDriverS3 {
		global.S3Bucket = cfg.S3Bucket
		global.S3Region = cfg.S3Region
		global.S3Prefix = cfg.S3Prefix
	} else {
		global.LocalDir = cfg.StorageDir
	}

	rows := make([]EffectiveStorage, 0, 1+len(config.StorageScopeNames()))
	rows = append(rows, global)
	for _, scope := range config.StorageScopeNames() {
		rows = append(rows, effectiveScopeStorage(cfg, scope, global))
	}
	return rows
}

// effectiveScopeStorage resolves one media purpose.
//
// The S3 endpoint, region and credentials are deployment wide by design: a scope only
// chooses the driver and, for S3, its bucket and key prefix. A scope row therefore
// never carries a region of its own.
func effectiveScopeStorage(cfg config.Config, scope string, global EffectiveStorage) EffectiveStorage {
	switch strings.ToLower(strings.TrimSpace(cfg.StorageScopes[scope].Driver)) {
	case config.StorageDriverLocal:
		scoped := cfg.StorageScopes[scope]
		dir := scoped.LocalDir
		if dir == "" {
			// config.Load defaults an override to <global dir>/<scope>; a Config built
			// by hand skips that step, so repeat the default instead of reporting a
			// directory the adapter would never use.
			dir = filepath.Join(cfg.StorageDir, scope)
		}
		return EffectiveStorage{Scope: scope, Driver: config.StorageDriverLocal, LocalDir: dir}

	case config.StorageDriverS3:
		scoped := cfg.StorageScopes[scope]
		prefix := scoped.S3Prefix
		if prefix == "" {
			prefix = scopeStoragePrefix(cfg.S3Prefix, scope)
		}
		return EffectiveStorage{
			Scope:    scope,
			Driver:   config.StorageDriverS3,
			S3Bucket: scoped.S3Bucket,
			S3Region: cfg.S3Region,
			S3Prefix: prefix,
		}

	default:
		// inherit (the loader's default), an absent entry, or a driver this binary does
		// not know: all three are served by the global adapter.
		inherited := global
		inherited.Scope = scope
		return inherited
	}
}

// globalStorageDriver normalises the global driver name.
//
// config.Load rejects anything but local and s3 and defaults an unset value to local, so
// only a hand built Config reaches the fallback; answering "local" is what the media
// adapters then do as well.
func globalStorageDriver(driver string) string {
	if strings.EqualFold(strings.TrimSpace(driver), config.StorageDriverS3) {
		return config.StorageDriverS3
	}
	return config.StorageDriverLocal
}

// scopeStoragePrefix mirrors the loader's default key prefix for a scope override: the
// global prefix with the scope's name appended, so two purposes never share keys.
func scopeStoragePrefix(base, scope string) string {
	base = strings.Trim(base, "/")
	if base == "" {
		return scope
	}
	return base + "/" + scope
}

// nonNilStrings trims a configuration list and encodes it as a JSON array even when it
// is empty. The admin pages iterate these lists; a null would force an extra guard into
// every consumer for a case that only means "nothing configured".
func nonNilStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
