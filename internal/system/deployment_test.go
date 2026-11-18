package system

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
)

// deploymentConfigForTest is a deployment where every value the endpoint reports is
// non-default: a default would hide a field that silently stops being filled in.
func deploymentConfigForTest() config.Config {
	return config.Config{
		AppEnv:             config.EnvProduction,
		StorageDriver:      config.StorageDriverS3,
		StorageDir:         "/srv/practacu/media",
		S3Bucket:           "press-media",
		S3Region:           "eu-west-1",
		S3Endpoint:         "https://s3.example.com",
		S3AccessKey:        "AKIAIOSFODNN7EXAMPLE",
		S3SecretKey:        "s3-secret-do-not-leak",
		S3Prefix:           "media",
		CORSAllowedOrigins: []string{"https://example.com"},
		CORSCredentials:    true,
		TrustedProxies:     []string{"10.0.0.0/8"},
		PublicBaseURL:      "https://example.com",
		SMTPHost:           "smtp.example.com",
		SMTPPort:           587,
		SMTPEncryption:     config.SMTPEncryptionStartTLS,
		SMTPUsername:       "mailer",
		SMTPPassword:       "smtp-secret-do-not-leak",
		SMTPFrom:           "noreply@example.com",
		AuthJWTPrivateKey:  "jwt-key-do-not-leak",
		FieldEncryptionKey: "field-key-do-not-leak",
	}
}

// newDeploymentEngine mounts the effective configuration route the way the router does.
func newDeploymentEngine(t *testing.T, deployment func() config.Config) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	handler := NewHandler(func() Snapshot { return Snapshot{} }, HandlerConfig{
		Principal: func(c *gin.Context) (string, bool) {
			role := c.GetHeader("X-Test-Role")
			if role == "" {
				return "", false
			}
			return role, true
		},
		Deployment: deployment,
	})
	return mountDeploymentRoutes(handler)
}

// mountDeploymentRoutes uses the same primitives the router does: the request id and the
// error translator, so an aborted handler is observed through its HTTP status.
func mountDeploymentRoutes(handler *Handler) *gin.Engine {
	engine := gin.New()
	engine.Use(
		middleware.RequestID(),
		middleware.ErrorHandler(slog.New(slog.NewTextHandler(io.Discard, nil))),
	)
	noop := func(c *gin.Context) { c.Next() }
	handler.Routes(engine.Group("/api/v1"), noop)
	handler.RoutesEffectiveConfig(engine.Group("/api/v1"), noop)
	return engine
}

func requestEffectiveConfig(t *testing.T, engine *gin.Engine, role string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/system/effective-config", nil)
	if role != "" {
		request.Header.Set("X-Test-Role", role)
	}
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	return recorder
}

func storageByScope(rows []EffectiveStorage) map[string]EffectiveStorage {
	byScope := make(map[string]EffectiveStorage, len(rows))
	for _, row := range rows {
		byScope[row.Scope] = row
	}
	return byScope
}

func TestEffectiveStorageReusesGlobalAdapterForInheritedScopes(t *testing.T) {
	cfg := config.Config{
		StorageDriver: config.StorageDriverLocal,
		StorageDir:    "./data/media",
		StorageScopes: map[string]config.StorageScopeConfig{
			config.StorageScopeAvatar: {Driver: config.StorageDriverInherit},
		},
	}

	rows := effectiveStorage(cfg)
	require.Len(t, rows, 1+len(config.StorageScopeNames()))

	byScope := storageByScope(rows)
	require.Equal(t, EffectiveStorage{
		Scope:    StorageScopeGlobal,
		Driver:   config.StorageDriverLocal,
		LocalDir: "./data/media",
	}, byScope[StorageScopeGlobal])

	// An "inherit" (or absent) purpose is served by the global adapter, so the row has
	// to repeat the global values: empty strings would report a directory that is never
	// used, which is the bug this endpoint exists to end.
	for _, scope := range config.StorageScopeNames() {
		require.Equal(t, EffectiveStorage{
			Scope:    scope,
			Driver:   config.StorageDriverLocal,
			LocalDir: "./data/media",
		}, byScope[scope], "scope %s", scope)
	}
}

func TestEffectiveStorageReportsScopeOverrides(t *testing.T) {
	cfg := config.Config{
		StorageDriver: config.StorageDriverS3,
		StorageDir:    "/srv/practacu/media",
		S3Bucket:      "press-media",
		S3Region:      "eu-west-1",
		S3Prefix:      "/media/",
		StorageScopes: map[string]config.StorageScopeConfig{
			config.StorageScopeAvatar:  {Driver: config.StorageDriverLocal, LocalDir: "/srv/practacu/avatars"},
			config.StorageScopeSite:    {Driver: config.StorageDriverS3, S3Bucket: "press-site"},
			config.StorageScopeContent: {Driver: config.StorageDriverS3, S3Bucket: "press-content", S3Prefix: "static/content"},
		},
	}

	byScope := storageByScope(effectiveStorage(cfg))

	require.Equal(t, EffectiveStorage{
		Scope:    StorageScopeGlobal,
		Driver:   config.StorageDriverS3,
		S3Bucket: "press-media",
		S3Region: "eu-west-1",
		S3Prefix: "/media/",
	}, byScope[StorageScopeGlobal])

	require.Equal(t, EffectiveStorage{
		Scope:    config.StorageScopeAvatar,
		Driver:   config.StorageDriverLocal,
		LocalDir: "/srv/practacu/avatars",
	}, byScope[config.StorageScopeAvatar])

	require.Equal(t, EffectiveStorage{
		Scope:    config.StorageScopeContent,
		Driver:   config.StorageDriverS3,
		S3Bucket: "press-content",
		S3Region: "eu-west-1",
		S3Prefix: "static/content",
	}, byScope[config.StorageScopeContent])

	// A scope that picks S3 but no prefix uses the deployment prefix with its own
	// purpose appended, so two purposes never write to the same keys.
	require.Equal(t, EffectiveStorage{
		Scope:    config.StorageScopeSite,
		Driver:   config.StorageDriverS3,
		S3Bucket: "press-site",
		S3Region: "eu-west-1",
		S3Prefix: "media/site",
	}, byScope[config.StorageScopeSite])

	// No entry at all is the loader's "inherit" state.
	require.Equal(t, EffectiveStorage{
		Scope:    config.StorageScopeAttachment,
		Driver:   config.StorageDriverS3,
		S3Bucket: "press-media",
		S3Region: "eu-west-1",
		S3Prefix: "/media/",
	}, byScope[config.StorageScopeAttachment])
}

func TestEffectiveStorageLocalOverrideDefaultsToScopeDirectory(t *testing.T) {
	cfg := config.Config{
		StorageDriver: config.StorageDriverLocal,
		StorageDir:    "/srv/practacu/media",
		StorageScopes: map[string]config.StorageScopeConfig{
			// Hand built config: the loader would have filled LocalDir in.
			config.StorageScopeContent: {Driver: config.StorageDriverLocal},
		},
	}

	byScope := storageByScope(effectiveStorage(cfg))
	require.Equal(t, filepath.Join("/srv/practacu/media", config.StorageScopeContent),
		byScope[config.StorageScopeContent].LocalDir)
}

func TestDeploymentSnapshotReportsEffectivePolicy(t *testing.T) {
	capturedAt := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	cfg := deploymentConfigForTest()
	cfg.CORSAllowedOrigins = []string{"https://example.com", "  https://studio.example.com  "}

	snapshot := deploymentSnapshot(cfg, capturedAt)

	require.Equal(t, []string{"https://example.com", "https://studio.example.com"}, snapshot.CORS.AllowedOrigins)
	require.True(t, snapshot.CORS.AllowCredentials)
	require.Equal(t, EffectiveDomains{
		HTTPSOnly:      false,
		PublicBaseURL:  "https://example.com",
		TrustedProxies: []string{"10.0.0.0/8"},
	}, snapshot.Domains)
	require.Equal(t, EffectiveMail{
		Configured: true,
		Encryption: config.SMTPEncryptionStartTLS,
		From:       "noreply@example.com",
	}, snapshot.Mail)
	require.True(t, snapshot.RestartRequired)
	require.Equal(t, capturedAt, snapshot.CapturedAt)
	require.Len(t, snapshot.Storage, 1+len(config.StorageScopeNames()))
}

func TestDeploymentSnapshotEncodesEmptyListsAsArrays(t *testing.T) {
	raw, err := json.Marshal(deploymentSnapshot(config.Config{}, time.Unix(0, 0).UTC()))
	require.NoError(t, err)

	// The admin pages iterate these lists, so "nothing configured" must be [] and not
	// null; only then can the browser skip an extra guard.
	require.Contains(t, string(raw), `"allowed_origins":[]`)
	require.Contains(t, string(raw), `"trusted_proxies":[]`)
	require.Contains(t, string(raw), `"mail":{"configured":false`)
	require.Contains(t, string(raw), `"restart_required":true`)
}

func TestDeploymentSnapshotCarriesNoCredentials(t *testing.T) {
	cfg := deploymentConfigForTest()
	cfg.BackupEncryptionKey = "backup-key-do-not-leak"
	cfg.CookieDomain = ".example.com"
	cfg.SMSHTTPToken = "sms-secret-do-not-leak"
	raw, err := json.Marshal(deploymentSnapshot(cfg, time.Unix(0, 0).UTC()))
	require.NoError(t, err)
	body := string(raw)

	for _, secret := range []string{
		cfg.S3AccessKey,
		cfg.S3SecretKey,
		cfg.SMTPPassword,
		cfg.AuthJWTPrivateKey,
		cfg.FieldEncryptionKey,
		cfg.BackupEncryptionKey,
		cfg.SMSHTTPToken,
		cfg.S3Endpoint,
	} {
		require.NotContains(t, body, secret, "a credential reached the response payload")
	}
	// The field names matter as much as the values: a future edit that adds one of
	// these keys would be a leak even while the configured value is empty.
	for _, key := range []string{"access_key", "secret", "password", "token", "private_key"} {
		require.NotContains(t, strings.ToLower(body), key)
	}
}

func TestEffectiveConfigRequiresAdministrator(t *testing.T) {
	engine := newDeploymentEngine(t, func() config.Config { return deploymentConfigForTest() })

	cases := map[string]int{
		// The settings pages that read these values are site scoped, so their
		// administrator may read the deployment view of them.
		string(site.RoleSiteAdmin):         http.StatusOK,
		string(site.RolePlatformAdmin):     http.StatusOK,
		string(site.RoleEditor):            http.StatusForbidden,
		string(site.RoleMember):            http.StatusForbidden,
		"a_role_this_binary_does_not_know": http.StatusForbidden,
	}
	for role, want := range cases {
		recorder := requestEffectiveConfig(t, engine, role)
		require.Equal(t, want, recorder.Code, "role %s", role)
	}
}

func TestEffectiveConfigRequiresAuthentication(t *testing.T) {
	engine := newDeploymentEngine(t, func() config.Config { return deploymentConfigForTest() })

	recorder := requestEffectiveConfig(t, engine, "")

	require.Equal(t, http.StatusUnauthorized, recorder.Code)
}

func TestEffectiveConfigReturnsTheSnapshot(t *testing.T) {
	engine := newDeploymentEngine(t, func() config.Config { return deploymentConfigForTest() })

	recorder := requestEffectiveConfig(t, engine, string(site.RoleSiteAdmin))
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))

	var body struct {
		Storage         []EffectiveStorage `json:"storage"`
		CORS            EffectiveCORS      `json:"cors"`
		Domains         EffectiveDomains   `json:"domains"`
		Mail            EffectiveMail      `json:"mail"`
		RestartRequired bool               `json:"restart_required"`
		CapturedAt      time.Time          `json:"captured_at"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))

	require.Equal(t, "press-media", body.Storage[0].S3Bucket)
	require.Equal(t, []string{"https://example.com"}, body.CORS.AllowedOrigins)
	require.Equal(t, "https://example.com", body.Domains.PublicBaseURL)
	require.Equal(t, "noreply@example.com", body.Mail.From)
	require.True(t, body.RestartRequired)
	require.False(t, body.CapturedAt.IsZero())
	require.WithinDuration(t, time.Now().UTC(), body.CapturedAt, time.Minute)
	require.NotContains(t, recorder.Body.String(), "s3-secret-do-not-leak")
}

func TestEffectiveConfigFailsClosedWithoutDeploymentSource(t *testing.T) {
	engine := newDeploymentEngine(t, nil)

	recorder := requestEffectiveConfig(t, engine, string(site.RolePlatformAdmin))

	require.Equal(t, http.StatusInternalServerError, recorder.Code)
}

func TestEffectiveConfigWorksWithoutTheResourcePanel(t *testing.T) {
	// The settings pages that read this payload are not part of the optional metrics
	// module, so the endpoint must not depend on a sampler being wired.
	handler := NewHandler(nil, HandlerConfig{
		Principal:  func(*gin.Context) (string, bool) { return string(site.RoleSiteAdmin), true },
		Deployment: func() config.Config { return deploymentConfigForTest() },
	})
	engine := mountDeploymentRoutes(handler)

	recorder := requestEffectiveConfig(t, engine, string(site.RoleSiteAdmin))
	require.Equal(t, http.StatusOK, recorder.Code)

	// The panel route, by contrast, is not registered at all when the module is off.
	metrics := httptest.NewRecorder()
	engine.ServeHTTP(metrics, httptest.NewRequest(http.MethodGet, "/api/v1/system/metrics", nil))
	require.Equal(t, http.StatusNotFound, metrics.Code)
}
