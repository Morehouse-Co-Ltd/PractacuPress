package site_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func siteConfigPath(siteID string) string {
	return "/api/v1/sites/" + siteID + "/site-config"
}

// siteConfigBody is the document the admin screens save.
func siteConfigBody() map[string]any {
	return map[string]any{
		"admin_path": "/manage",
		"access": map[string]any{
			"enabled":     true,
			"page_switch": map[string]any{"enabled": true, "limit": 40, "window_seconds": 60, "block_seconds": 30},
			"requests":    map[string]any{"enabled": true, "limit": 180, "window_seconds": 60, "block_seconds": 30},
			"tabs":        map[string]any{"enabled": true, "limit": 8},
			"message":     "稍后再试。",
		},
		"domains": map[string]any{
			"enabled":         true,
			"primary":         "example.com",
			"aliases":         []string{"www.example.com"},
			"allow_www":       true,
			"allow_localhost": true,
			"allow_ip":        false,
			"tls":             map[string]any{"mode": "manual", "key_path": "/etc/ssl/site.key"},
			"cors_origins":    []string{"https://example.com"},
			"trusted_proxies": []string{"10.0.0.0/8"},
		},
		"performance": map[string]any{
			"feed_limit":         12,
			"archive_limit":      24,
			"disable_animations": true,
			"db_max_open_conns":  10,
		},
		"loading": map[string]any{"enabled": true, "preset": "dots", "text": "正在打开"},
		"auth": map[string]any{
			"google": map[string]any{"enabled": true, "client_id": "client-123"},
		},
	}
}

// TestSiteConfigRoundTripAndAudienceSplit is the contract the browser depends on: an
// administrator saves the configuration, the anonymous boot request receives the public
// projection, and the administrator's own read receives the whole document.
func TestSiteConfigRoundTripAndAudienceSplit(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promote(t, "site_admin")
	path := siteConfigPath(h.siteID)

	require.Equal(t, http.StatusNotFound, h.get(t, path, "").Code,
		"a fresh site falls back to browser defaults")

	saved := h.put(t, path, token, map[string]any{"config": siteConfigBody()})
	require.Equal(t, http.StatusOK, saved.Code, saved.Body.String())

	var saveBody struct {
		Revision  int    `json:"revision"`
		UpdatedAt string `json:"updated_at"`
	}
	require.NoError(t, json.Unmarshal(saved.Body.Bytes(), &saveBody))
	require.Equal(t, 1, saveBody.Revision)
	require.NotEmpty(t, saveBody.UpdatedAt)

	// Anonymous read: the projection a visitor's browser executes.
	anonymous := h.get(t, path, "")
	require.Equal(t, http.StatusOK, anonymous.Code, anonymous.Body.String())
	var publicBody struct {
		SiteID   string         `json:"site_id"`
		Revision int            `json:"revision"`
		Scope    string         `json:"scope"`
		Config   map[string]any `json:"config"`
	}
	require.NoError(t, json.Unmarshal(anonymous.Body.Bytes(), &publicBody))
	require.Equal(t, h.siteID, publicBody.SiteID)
	require.Equal(t, 1, publicBody.Revision)
	require.Equal(t, "public", publicBody.Scope)
	require.Equal(t, "/manage", publicBody.Config["admin_path"])
	require.Contains(t, publicBody.Config, "access")
	require.Contains(t, publicBody.Config, "loading")
	// Public auth is the switch only: the login page must know which providers are on,
	// the client id stays administrator-only.
	auth, ok := publicBody.Config["auth"].(map[string]any)
	require.True(t, ok, "the login page needs the provider switches")
	google, ok := auth["google"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, true, google["enabled"])
	require.NotContains(t, google, "client_id")

	domains, ok := publicBody.Config["domains"].(map[string]any)
	require.True(t, ok, "the visitor guard needs the bound domains")
	require.NotContains(t, domains, "tls")
	require.NotContains(t, domains, "trusted_proxies")
	require.NotContains(t, domains, "cors_origins")
	performance, ok := publicBody.Config["performance"].(map[string]any)
	require.True(t, ok)
	require.NotContains(t, performance, "db_max_open_conns")

	// The administrator's read is the whole document, so the editor can round-trip it.
	adminRead := h.get(t, path, token)
	require.Equal(t, http.StatusOK, adminRead.Code, adminRead.Body.String())
	var adminBody struct {
		Scope  string         `json:"scope"`
		Config map[string]any `json:"config"`
	}
	require.NoError(t, json.Unmarshal(adminRead.Body.Bytes(), &adminBody))
	require.Equal(t, "admin", adminBody.Scope)
	require.Contains(t, adminBody.Config, "auth")
	require.Equal(t, "/etc/ssl/site.key",
		adminBody.Config["domains"].(map[string]any)["tls"].(map[string]any)["key_path"])
}

// TestSiteConfigAnonymousReadIsCacheableWithETag keeps the every-boot request cheap: the
// visitor's browser can revalidate instead of downloading the document again.
func TestSiteConfigAnonymousReadIsCacheableWithETag(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promote(t, "site_admin")
	path := siteConfigPath(h.siteID)
	require.Equal(t, http.StatusOK, h.put(t, path, token, map[string]any{"config": siteConfigBody()}).Code)

	first := h.get(t, path, "")
	require.Equal(t, http.StatusOK, first.Code)
	etag := first.Header().Get("ETag")
	require.NotEmpty(t, etag)
	require.Equal(t, "private, no-cache", first.Header().Get("Cache-Control"))

	// The same ETag revalidates to a bodyless 304.
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("If-None-Match", etag)
	recorder := httptest.NewRecorder()
	h.router.ServeHTTP(recorder, req)
	require.Equal(t, http.StatusNotModified, recorder.Code)
}

// TestSiteConfigWriteRequiresManageSite keeps a plain member out of the access rules.
func TestSiteConfigWriteRequiresManageSite(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "reader@example.com")

	w := h.put(t, siteConfigPath(h.siteID), token, map[string]any{"config": siteConfigBody()})
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, http.StatusNotFound, h.get(t, siteConfigPath(h.siteID), "").Code,
		"a denied write must not have stored anything")
}

func TestSiteConfigWriteIsRefusedWithoutAToken(t *testing.T) {
	h := newHarness(t)

	w := h.put(t, siteConfigPath(h.siteID), "", map[string]any{"config": siteConfigBody()})
	require.Equal(t, http.StatusUnauthorized, w.Code, w.Body.String())
}

// TestSiteConfigStaleRevisionConflicts is the two-device case at the HTTP level.
func TestSiteConfigStaleRevisionConflicts(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promote(t, "site_admin")
	path := siteConfigPath(h.siteID)

	require.Equal(t, http.StatusOK, h.put(t, path, token, map[string]any{"config": siteConfigBody()}).Code)
	require.Equal(t, http.StatusOK,
		h.put(t, path, token, map[string]any{"config": siteConfigBody(), "revision": 1}).Code,
		"revision 1 is current")

	conflict := h.put(t, path, token, map[string]any{"config": siteConfigBody(), "revision": 1})
	require.Equal(t, http.StatusConflict, conflict.Code, conflict.Body.String())
	require.Contains(t, conflict.Body.String(), "config_revision_conflict")
}

// TestSiteConfigRejectsReservedAdminPath stops the configured entry from shadowing a real
// site route: /login behind the admin shell would make signing in impossible.
func TestSiteConfigRejectsReservedAdminPath(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promote(t, "site_admin")

	body := siteConfigBody()
	body["admin_path"] = "/login"
	w := h.put(t, siteConfigPath(h.siteID), token, map[string]any{"config": body})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "admin_path")
}

// TestSiteConfigRejectsMalformedDocument keeps a payload the browser could not interpret
// out of the database instead of storing it and rendering defaults on every device.
func TestSiteConfigRejectsMalformedDocument(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promote(t, "site_admin")

	for name, config := range map[string]any{
		"array":  []any{1, 2, 3},
		"scalar": "config",
		"null":   nil,
	} {
		w := h.put(t, siteConfigPath(h.siteID), token, map[string]any{"config": config})
		require.Equal(t, http.StatusBadRequest, w.Code, "%s: %s", name, w.Body.String())
	}
}

// TestSiteConfigOnMembersOnlySiteIsHiddenFromOutsiders mirrors the design document rule:
// the configuration names the admin entry and the bound domains of a closed site, so an
// outsider gets the same 404 a site without a configuration returns.
func TestSiteConfigOnMembersOnlySiteIsHiddenFromOutsiders(t *testing.T) {
	h := newHarnessWithVisibility(t, "members_only")
	token := h.register(t, "owner@example.com")
	h.promote(t, "site_admin")
	path := siteConfigPath(h.siteID)

	require.Equal(t, http.StatusOK, h.put(t, path, token, map[string]any{"config": siteConfigBody()}).Code)
	require.Equal(t, http.StatusOK, h.get(t, path, token).Code, "a member reads the configuration")

	anonymous := h.get(t, path, "")
	require.Equal(t, http.StatusNotFound, anonymous.Code, anonymous.Body.String())
	require.NotContains(t, anonymous.Body.String(), "unauthenticated")
}
