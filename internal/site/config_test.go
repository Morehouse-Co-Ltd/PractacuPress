package site

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// siteConfigDocumentForTest is the shape the admin screens write: the browser fields
// plus the administrator-only fields the public projection must hide.
func siteConfigDocumentForTest() []byte {
	return []byte(`{
		"admin_path": "/manage",
		"access": {
			"enabled": true,
			"page_switch": {"enabled": true, "limit": 40, "window_seconds": 60, "block_seconds": 30},
			"requests": {"enabled": true, "limit": 180, "window_seconds": 60, "block_seconds": 30},
			"tabs": {"enabled": true, "limit": 8},
			"message": "访问过于频繁，请稍后再试。"
		},
		"domains": {
			"enabled": true,
			"primary": "example.com",
			"aliases": ["www.example.com"],
			"allow_www": true,
			"allow_localhost": true,
			"allow_ip": false,
			"redirect_primary": true,
			"https_only": true,
			"tls": {"mode": "letsencrypt", "email": "ops@example.com", "cert_path": "/etc/ssl/site.pem", "key_path": "/etc/ssl/site.key", "hsts": true},
			"cors_origins": ["https://example.com"],
			"cookie_domain": ".example.com",
			"trusted_proxies": ["10.0.0.0/8"]
		},
		"performance": {
			"feed_limit": 12,
			"archive_limit": 24,
			"request_cache": true,
			"cache_ttl": 30,
			"lazy_media": true,
			"disable_animations": true,
			"preconnect": ["https://fonts.example.com"],
			"gzip": true,
			"static_cache_days": 365,
			"keepalive_timeout": 65,
			"client_max_body_size_mb": 32,
			"proxy_read_timeout": 60,
			"api_read_timeout": 30,
			"api_idle_timeout": 120,
			"db_max_open_conns": 10,
			"db_max_idle_conns": 5,
			"db_conn_max_lifetime": 1800
		},
		"loading": {
			"enabled": true,
			"preset": "dots",
			"text": "正在打开",
			"accent_mode": "custom",
			"accent": "#c2410c",
			"background_mode": "theme",
			"background": "",
			"size": 42,
			"min_duration_ms": 400,
			"show_on_first_load": true,
			"show_on_navigation": true,
			"custom_css": ".pp-loading-overlay { letter-spacing: 0.1em; }"
		},
		"auth": {
			"google": {"enabled": true, "client_id": "client-123", "redirect_uri": "https://example.com/cb", "extra": "openid", "note": ""}
		}
	}`)
}

func TestSaveSiteConfigStoresTheDocumentByteForByte(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	document := siteConfigDocumentForTest()
	saved, err := service.SaveSiteConfig(context.Background(), admin, "s1", document, 0, "req")
	require.NoError(t, err)
	require.Equal(t, 1, saved.Revision)
	require.Equal(t, document, saved.Document, "the document must be stored verbatim")
}

func TestSaveSiteConfigRequiresManageSite(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	member := activeMember("s1", "u2", RoleEditor)

	_, err := service.SaveSiteConfig(context.Background(), member, "s1", siteConfigDocumentForTest(), 0, "req")
	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Empty(t, repo.siteConfig, "a denied write must not reach the repository")
}

func TestSaveSiteConfigUsesOptimisticConcurrency(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	admin := activeMember("s1", "u1", RoleSiteAdmin)
	ctx := context.Background()

	first, err := service.SaveSiteConfig(ctx, admin, "s1", siteConfigDocumentForTest(), 0, "req")
	require.NoError(t, err)
	require.Equal(t, 1, first.Revision)

	second, err := service.SaveSiteConfig(ctx, admin, "s1", []byte(`{"admin_path":"/manage"}`), 1, "req")
	require.NoError(t, err)
	require.Equal(t, 2, second.Revision)

	_, err = service.SaveSiteConfig(ctx, admin, "s1", siteConfigDocumentForTest(), 1, "req")
	require.ErrorIs(t, err, ErrSiteConfigConflict)
}

func TestSaveSiteConfigAuditsWithoutTheDocument(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	_, err := service.SaveSiteConfig(context.Background(), admin, "s1", siteConfigDocumentForTest(), 0, "req-1")
	require.NoError(t, err)

	require.Len(t, repo.audits, 1)
	audit := repo.audits[0]
	require.Equal(t, "site.config.updated", audit.Action)
	require.Equal(t, "req-1", audit.RequestID)
	require.NotContains(t, audit.Detail, "document")
	// Certificate paths and OAuth client ids must not reach the audit log through a
	// detail field either.
	detail, err := json.Marshal(audit.Detail)
	require.NoError(t, err)
	require.NotContains(t, string(detail), "example.com")
	require.NotContains(t, string(detail), "client-123")
}

// TestSaveSiteConfigRejectsOutOfRangeFields is the bug this feature fixes: a value the
// browser would clamp or ignore must fail at save time instead of making the owner's
// browser the only one that "looks right".
func TestSaveSiteConfigRejectsOutOfRangeFields(t *testing.T) {
	service := newService(t, newFakeRepo())
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	cases := map[string]string{
		"access limit":        `{"access":{"requests":{"limit":0}}}`,
		"access window":       `{"access":{"page_switch":{"window_seconds":0}}}`,
		"tabs limit":          `{"access":{"tabs":{"limit":99}}}`,
		"feed limit":          `{"performance":{"feed_limit":61}}`,
		"cache ttl":           `{"performance":{"cache_ttl":0}}`,
		"db pool":             `{"performance":{"db_max_open_conns":-1}}`,
		"loading size":        `{"loading":{"size":2}}`,
		"loading preset":      `{"loading":{"preset":"carousel"}}`,
		"loading mode":        `{"loading":{"accent_mode":"rainbow"}}`,
		"tls mode":            `{"domains":{"tls":{"mode":"selfsigned"}}}`,
		"too many aliases":    `{"domains":{"aliases":["a.com","b.com","c.com","d.com","e.com","f.com","g.com","h.com","i.com","j.com","k.com","l.com","m.com","n.com","o.com","p.com","q.com","r.com","s.com","t.com","u.com"]}}`,
		"wrong field type":    `{"access":{"enabled":"yes"}}`,
		"reserved admin path": `{"admin_path":"/login"}`,
		"admin path shape":    `{"admin_path":"admin"}`,
	}
	for name, document := range cases {
		_, err := service.SaveSiteConfig(context.Background(), admin, "s1", []byte(document), 0, "req")
		require.Error(t, err, name)
		require.ErrorIs(t, err, ErrInvalidInput, "%s: %v", name, err)
	}
}

func TestSaveSiteConfigRejectsDangerousLoadingCSS(t *testing.T) {
	service := newService(t, newFakeRepo())
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	document := []byte(`{"loading":{"enabled":true,"custom_css":"@import url(https://evil.example/x.css);"}}`)
	_, err := service.SaveSiteConfig(context.Background(), admin, "s1", document, 0, "req")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestSaveSiteConfigRejectsOversizedDocuments(t *testing.T) {
	service := newService(t, newFakeRepo())
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	huge := []byte(`{"note":"` + strings.Repeat("x", MaxSiteConfigBytes) + `"}`)
	_, err := service.SaveSiteConfig(context.Background(), admin, "s1", huge, 0, "req")
	require.ErrorIs(t, err, ErrSiteConfigTooLarge)
}

// TestPublicSiteConfigKeepsVisitorFieldsAndDropsAdminFields is the security property of
// the audience split: the anonymous boot payload carries what a browser executes and
// none of the deployment secrets.
func TestPublicSiteConfigKeepsVisitorFieldsAndDropsAdminFields(t *testing.T) {
	public, err := PublicSiteConfig(siteConfigDocumentForTest())
	require.NoError(t, err)

	var decoded struct {
		AdminPath   string                     `json:"admin_path"`
		Access      map[string]any             `json:"access"`
		Domains     map[string]any             `json:"domains"`
		Performance map[string]any             `json:"performance"`
		Loading     map[string]any             `json:"loading"`
		Auth        map[string]json.RawMessage `json:"auth"`
	}
	require.NoError(t, json.Unmarshal(public, &decoded))

	require.Equal(t, "/manage", decoded.AdminPath)
	require.Equal(t, true, decoded.Access["enabled"])
	require.Equal(t, true, decoded.Loading["enabled"])
	require.Equal(t, float64(12), decoded.Performance["feed_limit"])
	require.Equal(t, true, decoded.Performance["disable_animations"])
	require.Equal(t, []any{"www.example.com"}, decoded.Domains["aliases"])

	// Administrator-only sections and fields. The login provider switches are public
	// (the login page has to know which buttons to draw) but their parameters are not.
	require.JSONEq(t, `{"enabled":true}`, string(decoded.Auth["google"]))
	require.NotContains(t, string(decoded.Auth["google"]), "client-123")
	for _, field := range []string{"tls", "cors_origins", "cookie_domain", "trusted_proxies"} {
		require.NotContains(t, decoded.Domains, field)
	}
	for _, field := range []string{"gzip", "db_max_open_conns", "api_read_timeout"} {
		require.NotContains(t, decoded.Performance, field)
	}

	// Defense in depth: the raw secret values must not appear anywhere in the payload.
	require.NotContains(t, string(public), "client-123")
	require.NotContains(t, string(public), "/etc/ssl")
	require.NotContains(t, string(public), "10.0.0.0/8")
}

func TestPublicSiteConfigOnAnEmptyDocument(t *testing.T) {
	public, err := PublicSiteConfig(nil)
	require.NoError(t, err)
	require.JSONEq(t, `{}`, string(public))
}

func TestSiteCORSOriginsDropsLegacyWildcard(t *testing.T) {
	document := []byte(`{"domains":{"cors_origins":["*"," https://admin.example.com "]}}`)

	require.Equal(t, []string{"https://admin.example.com"}, SiteCORSOrigins(document))
}

// TestValidateAdminPathRules keeps the configured admin entry from shadowing a real site
// route, which would make that page unreachable instead of protected.
func TestValidateAdminPathRules(t *testing.T) {
	allowed := []string{"/admin", "/manage", "/backend-2026", "/ops/console"}
	for _, path := range allowed {
		require.NoError(t, validateAdminPath(path), path)
	}
	rejected := []string{"", "admin", "/", "/login", "/login/extra", "/api/v1", "/me", "/setup", "/a x", "/admin?x=1", "//evil"}
	for _, path := range rejected {
		if path == "" {
			continue // empty means "not configured", handled before this function
		}
		require.ErrorIs(t, validateAdminPath(path), ErrInvalidInput, path)
	}
}
