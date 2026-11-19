package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

func newEngine(handlers ...gin.HandlerFunc) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(handlers...)
	return r
}

func serve(r *gin.Engine, req *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func decodeProblem(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(body, &payload))
	return payload
}

// --- Request ID ---

func TestRequestIDGeneratesWhenAbsent(t *testing.T) {
	r := newEngine(RequestID())
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	w := serve(r, httptest.NewRequest(http.MethodGet, "/x", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.NotEmpty(t, w.Header().Get(HeaderRequestID))
}

func TestRequestIDReusesValidInbound(t *testing.T) {
	var seen string
	r := newEngine(RequestID())
	r.GET("/x", func(c *gin.Context) {
		seen = RequestIDFrom(c)
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set(HeaderRequestID, "client-trace-01")
	w := serve(r, req)

	require.Equal(t, "client-trace-01", seen)
	require.Equal(t, "client-trace-01", w.Header().Get(HeaderRequestID))
}

func TestRequestIDReplacesMalformedInbound(t *testing.T) {
	cases := []string{
		"has space",
		"<script>alert(1)</script>",
		"0123456789012345678901234567890123456789012345678901234567890123456789",
	}
	for _, bad := range cases {
		var seen string
		r := newEngine(RequestID())
		r.GET("/x", func(c *gin.Context) {
			seen = RequestIDFrom(c)
			c.Status(http.StatusOK)
		})

		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.Header.Set(HeaderRequestID, bad)
		serve(r, req)

		require.NotEqual(t, bad, seen)
		require.NotEmpty(t, seen)
	}
}

// --- Error handler ---

func TestErrorHandlerMapsProblemJSON(t *testing.T) {
	r := newEngine(RequestID(), ErrorHandler(nil))
	r.GET("/deny", func(c *gin.Context) {
		_ = c.Error(apperr.PermissionDenied())
	})

	w := serve(r, httptest.NewRequest(http.MethodGet, "/deny", nil))

	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, apperr.ContentType, w.Header().Get("Content-Type"))

	payload := decodeProblem(t, w.Body.Bytes())
	require.Equal(t, "permission_denied", payload["code"])
	require.Equal(t, float64(403), payload["status"])
	require.NotEmpty(t, payload["request_id"])
	require.Equal(t, w.Header().Get(HeaderRequestID), payload["request_id"])
	require.Equal(t, map[string]any{}, payload["details"])
}

func TestErrorHandlerHidesInternalDetail(t *testing.T) {
	r := newEngine(RequestID(), ErrorHandler(nil))
	r.GET("/boom", func(c *gin.Context) {
		_ = c.Error(errors.New(`pq: relation "users" does not exist`))
	})

	w := serve(r, httptest.NewRequest(http.MethodGet, "/boom", nil))

	require.Equal(t, http.StatusInternalServerError, w.Code)
	require.NotContains(t, w.Body.String(), "relation")
	require.Equal(t, "internal", decodeProblem(t, w.Body.Bytes())["code"])
}

func TestErrorHandlerDoesNotRewriteWrittenResponse(t *testing.T) {
	r := newEngine(RequestID(), ErrorHandler(nil))
	r.GET("/partial", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
		_ = c.Error(apperr.Internal(errors.New("after write")))
	})

	w := serve(r, httptest.NewRequest(http.MethodGet, "/partial", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"ok":true}`, w.Body.String())
}

func TestErrorHandlerPassesThroughSuccess(t *testing.T) {
	r := newEngine(RequestID(), ErrorHandler(nil))
	r.GET("/ok", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	w := serve(r, httptest.NewRequest(http.MethodGet, "/ok", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, "application/json; charset=utf-8", w.Header().Get("Content-Type"))
}

// --- Trusted proxies ---

func TestNewTrustedProxiesParsesCIDRAndIP(t *testing.T) {
	tp, err := NewTrustedProxies([]string{"10.0.0.0/8", "192.168.1.5", "", "  "})
	require.NoError(t, err)
	require.False(t, tp.Empty())

	require.True(t, tp.ContainsRemote("10.1.2.3:5555"))
	require.True(t, tp.ContainsRemote("192.168.1.5:1"))
	require.False(t, tp.ContainsRemote("203.0.113.9:1"))

	_, err = NewTrustedProxies([]string{"not-an-ip"})
	require.Error(t, err)

	_, err = NewTrustedProxies([]string{"10.0.0.0/99"})
	require.Error(t, err)
}

func TestEmptyTrustedProxiesTrustNothing(t *testing.T) {
	tp, err := NewTrustedProxies(nil)
	require.NoError(t, err)
	require.True(t, tp.Empty())
	require.False(t, tp.ContainsRemote("127.0.0.1:1"))
}

// --- Site resolution ---

type fakeResolver struct {
	sites map[string]site.Site
	err   error
}

func (f fakeResolver) Resolve(_ context.Context, hostname string) (site.Site, error) {
	if f.err != nil {
		return site.Site{}, f.err
	}
	if s, ok := f.sites[hostname]; ok {
		return s, nil
	}
	return site.Site{}, site.ErrNotFound
}

func siteEchoEngine(resolver SiteResolver, trusted TrustedProxies) *gin.Engine {
	r := newEngine(RequestID(), ErrorHandler(nil), ResolveSite(trusted, resolver))
	r.GET("/api/v1/echo", func(c *gin.Context) {
		s, ok := SiteFrom(c)
		if !ok {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "no site"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"site_id": s.ID})
	})
	return r
}

func TestResolveSiteStoresSite(t *testing.T) {
	trusted, _ := NewTrustedProxies(nil)
	r := siteEchoEngine(fakeResolver{sites: map[string]site.Site{
		"example.com": {ID: "site_1", Slug: "main"},
	}}, trusted)

	w := serve(r, httptest.NewRequest(http.MethodGet, "/api/v1/echo", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"site_id":"site_1"}`, w.Body.String())
}

func TestResolveSiteUnknownHostIsProblemJSON(t *testing.T) {
	trusted, _ := NewTrustedProxies(nil)
	r := siteEchoEngine(fakeResolver{sites: map[string]site.Site{}}, trusted)

	w := serve(r, httptest.NewRequest(http.MethodGet, "/api/v1/echo", nil))

	require.Equal(t, http.StatusNotFound, w.Code)
	require.Equal(t, "site_not_found", decodeProblem(t, w.Body.Bytes())["code"])
}

func TestResolveSiteUnverifiedDomain(t *testing.T) {
	trusted, _ := NewTrustedProxies(nil)
	r := siteEchoEngine(fakeResolver{err: site.ErrDomainUnverified}, trusted)

	w := serve(r, httptest.NewRequest(http.MethodGet, "/api/v1/echo", nil))

	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, "site_domain_unverified", decodeProblem(t, w.Body.Bytes())["code"])
}

func TestResolveSiteIgnoresForwardedHostFromUntrustedPeer(t *testing.T) {
	trusted, _ := NewTrustedProxies(nil)
	r := siteEchoEngine(fakeResolver{sites: map[string]site.Site{
		"example.com": {ID: "site_good"},
		"evil.com":    {ID: "site_evil"},
	}}, trusted)

	req := httptest.NewRequest(http.MethodGet, "http://example.com/api/v1/echo", nil)
	req.Header.Set("X-Forwarded-Host", "evil.com")
	req.RemoteAddr = "203.0.113.5:1234"

	w := serve(r, req)

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"site_id":"site_good"}`, w.Body.String())
}

func TestResolveSiteHonoursForwardedHostFromTrustedPeer(t *testing.T) {
	trusted, err := NewTrustedProxies([]string{"203.0.113.0/24"})
	require.NoError(t, err)

	r := siteEchoEngine(fakeResolver{sites: map[string]site.Site{
		"example.com": {ID: "site_good"},
		"evil.com":    {ID: "site_evil"},
	}}, trusted)

	req := httptest.NewRequest(http.MethodGet, "http://example.com/api/v1/echo", nil)
	req.Header.Set("X-Forwarded-Host", "evil.com")
	req.RemoteAddr = "203.0.113.5:1234"

	w := serve(r, req)

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"site_id":"site_evil"}`, w.Body.String())
}

func TestRequestHostStripsPortAndNormalises(t *testing.T) {
	trusted, _ := NewTrustedProxies(nil)

	req := httptest.NewRequest(http.MethodGet, "http://Example.COM:8443/x", nil)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = req

	require.Equal(t, "example.com", RequestHost(c, trusted))
}

// --- CORS ---

func corsEngine(cfg CORSConfig) *gin.Engine {
	r := newEngine(RequestID(), ErrorHandler(nil), CORS(cfg))
	r.GET("/x", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	return r
}

func TestCORSAllowsListedOrigin(t *testing.T) {
	r := corsEngine(CORSConfig{AllowedOrigins: []string{"https://app.example.com"}, AllowCredentials: true})

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Origin", "https://app.example.com")
	w := serve(r, req)

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, "https://app.example.com", w.Header().Get("Access-Control-Allow-Origin"))
	require.Equal(t, "true", w.Header().Get("Access-Control-Allow-Credentials"))
	require.Contains(t, w.Header().Values("Vary"), "Origin")
}

func TestCORSWildcardWithoutCredentials(t *testing.T) {
	r := corsEngine(CORSConfig{AllowedOrigins: []string{"*"}})

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Origin", "https://anything.test")
	w := serve(r, req)

	require.Equal(t, "*", w.Header().Get("Access-Control-Allow-Origin"))
}

func TestCORSPreflightFromListedOrigin(t *testing.T) {
	r := corsEngine(CORSConfig{AllowedOrigins: []string{"https://app.example.com"}})

	req := httptest.NewRequest(http.MethodOptions, "/x", nil)
	req.Header.Set("Origin", "https://app.example.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	w := serve(r, req)

	require.Equal(t, http.StatusNoContent, w.Code)
	require.Contains(t, w.Header().Get("Access-Control-Allow-Methods"), "POST")
	require.Contains(t, w.Header().Get("Access-Control-Allow-Headers"), "Idempotency-Key")
}

func TestCORSPreflightFromUnlistedOriginGetsNoHeaders(t *testing.T) {
	r := corsEngine(CORSConfig{AllowedOrigins: []string{"https://app.example.com"}})

	req := httptest.NewRequest(http.MethodOptions, "/x", nil)
	req.Header.Set("Origin", "https://evil.test")
	req.Header.Set("Access-Control-Request-Method", "POST")
	w := serve(r, req)

	// Falling through lets a site-level allow-list answer later; with no such rule
	// the request reaches the router and is refused without CORS headers.
	require.Equal(t, http.StatusNotFound, w.Code)
	require.Empty(t, w.Header().Get("Access-Control-Allow-Origin"))
}

func TestCORSSimpleRequestFromUnlistedOriginGetsNoHeaders(t *testing.T) {
	r := corsEngine(CORSConfig{AllowedOrigins: []string{"https://app.example.com"}})

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Origin", "https://evil.test")
	w := serve(r, req)

	require.Equal(t, http.StatusOK, w.Code)
	require.Empty(t, w.Header().Get("Access-Control-Allow-Origin"))
}

func TestCORSIgnoresRequestsWithoutOrigin(t *testing.T) {
	r := corsEngine(CORSConfig{AllowedOrigins: []string{"https://app.example.com"}})

	w := serve(r, httptest.NewRequest(http.MethodGet, "/x", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.Empty(t, w.Header().Get("Access-Control-Allow-Origin"))
}

// --- Rate limiting ---

func TestRateLimitRejectsAfterLimit(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	store := NewMemoryRateLimitStore(func() time.Time { return now })

	r := newEngine(RequestID(), ErrorHandler(nil), RateLimit(store, Policy{
		Limit:  2,
		Window: time.Minute,
		Key:    func(*gin.Context) string { return "fixed-key" },
	}))
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	for i := 0; i < 2; i++ {
		require.Equal(t, http.StatusOK, serve(r, httptest.NewRequest(http.MethodGet, "/x", nil)).Code)
	}

	w := serve(r, httptest.NewRequest(http.MethodGet, "/x", nil))
	require.Equal(t, http.StatusTooManyRequests, w.Code)
	require.Equal(t, "60", w.Header().Get("Retry-After"))
	require.Equal(t, "rate_limited", decodeProblem(t, w.Body.Bytes())["code"])

	// The next window admits the client again.
	now = now.Add(61 * time.Second)
	require.Equal(t, http.StatusOK, serve(r, httptest.NewRequest(http.MethodGet, "/x", nil)).Code)
}

func TestRateLimitSeparatesKeys(t *testing.T) {
	store := NewMemoryRateLimitStore(nil)
	r := newEngine(RequestID(), ErrorHandler(nil), RateLimit(store, Policy{
		Limit:  1,
		Window: time.Minute,
		Key:    func(c *gin.Context) string { return c.GetHeader("X-Test-Key") },
	}))
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	first := httptest.NewRequest(http.MethodGet, "/x", nil)
	first.Header.Set("X-Test-Key", "a")
	require.Equal(t, http.StatusOK, serve(r, first).Code)

	second := httptest.NewRequest(http.MethodGet, "/x", nil)
	second.Header.Set("X-Test-Key", "b")
	require.Equal(t, http.StatusOK, serve(r, second).Code)

	third := httptest.NewRequest(http.MethodGet, "/x", nil)
	third.Header.Set("X-Test-Key", "a")
	require.Equal(t, http.StatusTooManyRequests, serve(r, third).Code)
}

func TestRateLimitZeroLimitDisables(t *testing.T) {
	store := NewMemoryRateLimitStore(nil)
	allowed, _ := store.Allow("k", 0, time.Minute)
	require.True(t, allowed)
}

// TestRateLimitSkipDoesNotConsume keeps the SPA document and its assets out of
// the API budget: the process serves both, but a page load must not be able to
// exhaust the API limiter and turn the next navigation into a JSON 429.
func TestRateLimitSkipDoesNotConsume(t *testing.T) {
	store := NewMemoryRateLimitStore(nil)
	r := newEngine(RequestID(), ErrorHandler(nil), RateLimit(store, Policy{
		Limit:  1,
		Window: time.Minute,
		Skip:   func(c *gin.Context) bool { return strings.HasPrefix(c.Request.URL.Path, "/assets/") },
	}))
	r.GET("/api/x", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.NoRoute(func(c *gin.Context) { c.Status(http.StatusOK) })

	for i := 0; i < 3; i++ {
		require.Equal(t, http.StatusOK, serve(r, httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)).Code)
	}
	require.Equal(t, http.StatusOK, serve(r, httptest.NewRequest(http.MethodGet, "/api/x", nil)).Code)
	require.Equal(t, http.StatusTooManyRequests, serve(r, httptest.NewRequest(http.MethodGet, "/api/x", nil)).Code)
}

// TestRateLimitStoreIsBounded guards the memory ceiling: a flood of unique keys
// inside one window must not grow the map past maxEntries.
func TestRateLimitStoreIsBounded(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	store := NewMemoryRateLimitStore(func() time.Time { return now })
	store.maxEntries = 8

	for i := 0; i < 100; i++ {
		allowed, _ := store.Allow("key-"+strconv.Itoa(i), 10, time.Minute)
		require.True(t, allowed)
	}

	require.LessOrEqual(t, len(store.windows), store.maxEntries,
		"the store must never exceed its entry ceiling")
	require.Equal(t, 8, len(store.windows))
}
