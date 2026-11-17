package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// corsRequest builds a request that reaches the API the way a browser does: the Host
// header names the site the page was loaded from and Origin names the page itself.
func corsRequest(method, host, origin string) *http.Request {
	req := httptest.NewRequest(method, "http://"+host+"/api/v1/content", nil)
	req.Host = host
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return req
}

// siteCORSEngine mounts SiteCORS with a fixed answer and a handler that records that it ran.
func siteCORSEngine(patterns []string, ran *bool) *gin.Engine {
	r := newEngine(SiteCORS(func(*gin.Context) []string { return patterns }))
	r.Any("/api/v1/content", func(c *gin.Context) {
		if ran != nil {
			*ran = true
		}
		c.String(http.StatusOK, "ok")
	})
	return r
}

// assertNoCORSHeaders fails when the response carries any CORS grant. It is the core of
// the "not allowed means nothing at all" rule: a wildcard or an echoed origin here would
// silently allow every site.
func assertNoCORSHeaders(t *testing.T, header http.Header) {
	t.Helper()
	for name := range header {
		require.False(t, strings.HasPrefix(strings.ToLower(name), "access-control-"),
			"unexpected CORS header %s on a non-allowed origin", name)
	}
}

func TestSiteCORSGrantsListedOrigin(t *testing.T) {
	const origin = "https://admin.example.com"
	var ran bool
	r := siteCORSEngine([]string{origin, "https://other.example.net"}, &ran)

	w := serve(r, corsRequest(http.MethodGet, "press.example.com", origin))

	require.Equal(t, http.StatusOK, w.Code)
	require.True(t, ran, "an allowed cross origin request must reach the handler")
	require.Equal(t, origin, w.Header().Get("Access-Control-Allow-Origin"),
		"the origin is echoed, never a wildcard: the policy allows credentials")
	require.Equal(t, "true", w.Header().Get("Access-Control-Allow-Credentials"))
	require.Equal(t, siteCORSAllowedMethods, w.Header().Get("Access-Control-Allow-Methods"))
	require.Equal(t, siteCORSAllowedHeaders, w.Header().Get("Access-Control-Allow-Headers"))
	require.Contains(t, w.Header().Values("Vary"), "Origin")
}

func TestSiteCORSEchoesTheRequestingOrigin(t *testing.T) {
	patterns := []string{"https://a.example.com", "https://b.example.com"}
	r := siteCORSEngine(patterns, nil)

	// Two allowed origins, two responses: each must get its own origin back, otherwise
	// the browser caches one site's grant for another.
	for _, origin := range patterns {
		w := serve(r, corsRequest(http.MethodGet, "press.example.com", origin))
		require.Equal(t, origin, w.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestSiteCORSLeavesUnlistedOriginAlone(t *testing.T) {
	var ran bool
	r := siteCORSEngine([]string{"https://admin.example.com"}, &ran)
	const origin = "https://attacker.example.org"

	w := serve(r, corsRequest(http.MethodGet, "press.example.com", origin))

	require.Equal(t, http.StatusOK, w.Code, "a simple request is served, the browser withholds it")
	require.True(t, ran)
	assertNoCORSHeaders(t, w.Header())
}

func TestSiteCORSAnswersPreflightForListedOrigin(t *testing.T) {
	const origin = "https://admin.example.com"
	var ran bool
	r := siteCORSEngine([]string{origin}, &ran)

	req := corsRequest(http.MethodOptions, "press.example.com", origin)
	req.Header.Set("Access-Control-Request-Method", http.MethodPatch)
	req.Header.Set("Access-Control-Request-Headers", "authorization")
	w := serve(r, req)

	require.Equal(t, http.StatusNoContent, w.Code)
	require.False(t, ran, "a preflight is answered by the middleware, not by the route")
	require.Empty(t, w.Body.String())
	require.Equal(t, origin, w.Header().Get("Access-Control-Allow-Origin"))
	require.Equal(t, "true", w.Header().Get("Access-Control-Allow-Credentials"))
	require.Equal(t, "600", w.Header().Get("Access-Control-Max-Age"))
}

func TestSiteCORSLeavesPreflightForUnlistedOriginToTheRouter(t *testing.T) {
	var ran bool
	r := siteCORSEngine([]string{"https://admin.example.com"}, &ran)

	req := corsRequest(http.MethodOptions, "press.example.com", "https://attacker.example.org")
	req.Header.Set("Access-Control-Request-Method", http.MethodPatch)
	w := serve(r, req)

	// Not allowed means "no CORS handling at all": the request continues down the
	// chain (here the catch-all route answers it) instead of being granted.
	require.True(t, ran)
	require.Equal(t, http.StatusOK, w.Code)
	assertNoCORSHeaders(t, w.Header())
}

func TestSiteCORSHandlesWildcardEntry(t *testing.T) {
	r := siteCORSEngine([]string{"*"}, nil)
	const origin = "https://anywhere.example.org"

	w := serve(r, corsRequest(http.MethodGet, "press.example.com", origin))

	require.Equal(t, origin, w.Header().Get("Access-Control-Allow-Origin"),
		"even a wildcard rule echoes the origin, because credentials are allowed")
	require.Equal(t, "true", w.Header().Get("Access-Control-Allow-Credentials"))
}

func TestSiteCORSHandlesSubdomainWildcard(t *testing.T) {
	r := siteCORSEngine([]string{"https://*.example.com"}, nil)

	// The request arrives on a different host than every origin below, otherwise the
	// same origin check would skip CORS before the rule is even consulted.
	const host = "cms.example.com"

	allowed := []string{
		"https://press.example.com",
		"https://a.b.example.com",
		"https://example.com", // the zone itself, which an operator also owns
	}
	for _, origin := range allowed {
		w := serve(r, corsRequest(http.MethodGet, host, origin))
		require.Equal(t, origin, w.Header().Get("Access-Control-Allow-Origin"), "origin %s", origin)
	}

	denied := []string{
		"http://press.example.com",    // scheme is part of the rule
		"https://evil-example.com",    // shares a suffix, not a label boundary
		"https://example.com.evil.io", // the rule is a suffix, not a prefix
		"https://notexample.com",
	}
	for _, origin := range denied {
		w := serve(r, corsRequest(http.MethodGet, host, origin))
		assertNoCORSHeaders(t, w.Header())
	}
}

func TestSiteCORSIgnoresSameOriginRequests(t *testing.T) {
	const origin = "https://press.example.com"
	var ran bool
	// The list deliberately names the site's own origin: a same origin request must
	// still not be turned into a CORS response.
	r := siteCORSEngine([]string{origin}, &ran)

	w := serve(r, corsRequest(http.MethodPost, "press.example.com", origin))

	require.True(t, ran)
	require.Equal(t, http.StatusOK, w.Code)
	assertNoCORSHeaders(t, w.Header())
}

func TestSiteCORSIgnoresRequestsWithoutOrigin(t *testing.T) {
	r := siteCORSEngine([]string{"*"}, nil)

	w := serve(r, corsRequest(http.MethodGet, "press.example.com", ""))

	require.Equal(t, http.StatusOK, w.Code)
	assertNoCORSHeaders(t, w.Header())
}

func TestSiteCORSWithoutOriginSourceIsInert(t *testing.T) {
	r := newEngine(SiteCORS(nil))
	r.GET("/api/v1/content", func(c *gin.Context) { c.String(http.StatusOK, "ok") })

	w := serve(r, corsRequest(http.MethodGet, "press.example.com", "https://admin.example.com"))

	require.Equal(t, http.StatusOK, w.Code)
	assertNoCORSHeaders(t, w.Header())
}

func TestSiteCORSOnlyLooksUpOriginsForCrossOriginRequests(t *testing.T) {
	lookups := 0
	r := newEngine(SiteCORS(func(*gin.Context) []string {
		lookups++
		return []string{"https://admin.example.com"}
	}))
	r.GET("/api/v1/content", func(c *gin.Context) { c.String(http.StatusOK, "ok") })

	// Same origin and origin-less requests must not pay for the configuration read;
	// only the cross origin ones do.
	serve(r, corsRequest(http.MethodGet, "press.example.com", ""))
	serve(r, corsRequest(http.MethodGet, "press.example.com", "https://press.example.com"))
	require.Zero(t, lookups)

	serve(r, corsRequest(http.MethodGet, "press.example.com", "https://admin.example.com"))
	require.Equal(t, 1, lookups)
}

func TestSiteCORSAppliesOriginsFromStoredSiteConfig(t *testing.T) {
	// The wiring the router uses: the callback decodes the resolved site's stored
	// document, so this also covers the site package's read-only helper.
	document := []byte(`{
		"domains": {
			"primary": "press.example.com",
			"cors_origins": ["https://admin.example.com", "https://*.preview.example.com "]
		}
	}`)
	r := newEngine(SiteCORS(func(*gin.Context) []string { return site.SiteCORSOrigins(document) }))
	r.GET("/api/v1/content", func(c *gin.Context) { c.String(http.StatusOK, "ok") })

	w := serve(r, corsRequest(http.MethodGet, "press.example.com", "https://admin.example.com"))
	require.Equal(t, "https://admin.example.com", w.Header().Get("Access-Control-Allow-Origin"))

	w = serve(r, corsRequest(http.MethodGet, "press.example.com", "https://staging.preview.example.com"))
	require.Equal(t, "https://staging.preview.example.com", w.Header().Get("Access-Control-Allow-Origin"))
}
