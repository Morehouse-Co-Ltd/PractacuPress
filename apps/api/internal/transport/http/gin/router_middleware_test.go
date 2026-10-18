package ginrouter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

type stubSiteResolver struct {
	calls []string
	site  site.Site
	err   error
}

func (s *stubSiteResolver) Resolve(_ context.Context, hostname string) (site.Site, error) {
	s.calls = append(s.calls, hostname)
	return s.site, s.err
}

func TestRouterAssignsRequestID(t *testing.T) {
	r := New(Dependencies{Config: config.Config{AppEnv: config.EnvTest}})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	require.Len(t, w.Header().Get(middleware.HeaderRequestID), 36)
}

func TestRouterRateLimitApplies(t *testing.T) {
	r := New(Dependencies{Config: config.Config{
		AppEnv:             config.EnvTest,
		RateLimitPerMinute: 1,
	}})

	first := httptest.NewRecorder()
	r.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	require.Equal(t, http.StatusOK, first.Code)

	second := httptest.NewRecorder()
	r.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	require.Equal(t, http.StatusTooManyRequests, second.Code)
	require.Equal(t, middlewareContentTypeProblem, second.Header().Get("Content-Type"))
}

func TestRouterCORSHandlesPreflight(t *testing.T) {
	r := New(Dependencies{Config: config.Config{
		AppEnv:             config.EnvTest,
		CORSAllowedOrigins: []string{"https://app.example.com"},
		CORSCredentials:    true,
	}})

	req := httptest.NewRequest(http.MethodOptions, "/api/v1/openapi.json", nil)
	req.Header.Set("Origin", "https://app.example.com")
	req.Header.Set("Access-Control-Request-Method", "GET")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusNoContent, w.Code)
	require.Equal(t, "https://app.example.com", w.Header().Get("Access-Control-Allow-Origin"))
}

func TestRouterResolvesSiteWhenConfigured(t *testing.T) {
	resolver := &stubSiteResolver{site: site.Site{ID: "site_1", Slug: "main", Name: "Main"}}

	r := New(Dependencies{
		Config:       config.Config{AppEnv: config.EnvTest},
		SiteResolver: resolver,
	})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"example.com"}, resolver.calls)
}

func TestRouterRejectsUnknownHostWhenResolverPresent(t *testing.T) {
	resolver := &stubSiteResolver{err: site.ErrNotFound}

	r := New(Dependencies{
		Config:       config.Config{AppEnv: config.EnvTest},
		SiteResolver: resolver,
	})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil))

	require.Equal(t, http.StatusNotFound, w.Code)
	require.Equal(t, middlewareContentTypeProblem, w.Header().Get("Content-Type"))
	require.Contains(t, w.Body.String(), "site_not_found")
}

func TestRouterHealthzSkipsSiteResolution(t *testing.T) {
	resolver := &stubSiteResolver{err: site.ErrNotFound}

	r := New(Dependencies{
		Config:       config.Config{AppEnv: config.EnvTest},
		SiteResolver: resolver,
	})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.Empty(t, resolver.calls, "health checks must not depend on site state")
}

// middlewareContentTypeProblem mirrors the contract media type without importing
// the error package into every assertion.
const middlewareContentTypeProblem = "application/problem+json"
