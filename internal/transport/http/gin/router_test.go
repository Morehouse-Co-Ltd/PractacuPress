package ginrouter

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/site"
)

func testRouter(t *testing.T, deps Dependencies) *gin.Engine {
	t.Helper()
	if deps.Config.AppEnv == "" {
		deps.Config.AppEnv = config.EnvTest
	}
	return New(deps)
}

func TestRouterHealthz(t *testing.T) {
	r := testRouter(t, Dependencies{})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"status":"ok"}`, w.Body.String())
}

func TestRouterHealthzIgnoresReadiness(t *testing.T) {
	r := testRouter(t, Dependencies{
		Readiness: func(context.Context) error { return errors.New("db down") },
	})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))

	require.Equal(t, http.StatusOK, w.Code)
}

func TestRouterReadyzDefault(t *testing.T) {
	r := testRouter(t, Dependencies{})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/readyz", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"status":"ready"}`, w.Body.String())
}

func TestRouterReadyzUnready(t *testing.T) {
	r := testRouter(t, Dependencies{
		Readiness: func(context.Context) error { return errors.New("db down") },
	})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/readyz", nil))

	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.JSONEq(t, `{"status":"unready"}`, w.Body.String())
}

func TestRouterOpenAPIAvailableWithoutSession(t *testing.T) {
	r := testRouter(t, Dependencies{})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Header().Get("Content-Type"), "application/json")
	document := w.Body.String()
	require.Contains(t, document, `"openapi":"3.1.0"`)
	// The endpoint used to answer a placeholder with an empty paths object; the real
	// embedded contract must carry the routes the server serves.
	require.Contains(t, document, `"/articles"`)
	require.Contains(t, document, `"/sites/{siteID}/settings"`)
	require.NotContains(t, document, `"paths":{}`)
}

func TestRouterUnknownRouteIsProblemJSON(t *testing.T) {
	r := testRouter(t, Dependencies{})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/nope", nil))

	require.Equal(t, http.StatusNotFound, w.Code)
	require.Equal(t, "application/problem+json", w.Header().Get("Content-Type"))
	require.Contains(t, w.Body.String(), `"code":"not_found"`)
	require.Contains(t, w.Body.String(), `"path":"/api/v1/nope"`)
}

// stubInstall answers the setup status endpoint from a fixed value.
type stubInstall struct {
	status site.InstallStatus
	err    error
	host   string
}

func (s *stubInstall) InstallStatus(_ context.Context, hostname string) (site.InstallStatus, error) {
	s.host = hostname
	return s.status, s.err
}

// emptySites refuses every hostname, which is what a wiped database looks like.
type emptySites struct{}

func (emptySites) Resolve(context.Context, string) (site.Site, error) {
	return site.Site{}, site.ErrNotFound
}

func TestRouterSetupStatusReportsTheResolvedInstall(t *testing.T) {
	report := &stubInstall{status: site.InstallStatus{
		Installed:        true,
		SiteID:           "site_main",
		SiteName:         "Practacu Press",
		HasAdmin:         true,
		RegistrationOpen: true,
	}}
	r := testRouter(t, Dependencies{Install: report})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/setup/status", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"installed":true,"has_admin":true,"site_id":"site_main","site_name":"Practacu Press","registration_open":true,"public_base_url_configured":false}`, w.Body.String())
	require.Equal(t, "example.com", report.host)
}

func TestRouterSetupStatusIsReachableWithoutASite(t *testing.T) {
	// The versioned group aborts before any handler when no site resolves, so this
	// endpoint has to sit outside it: "no site" is the answer the wizard needs.
	report := &stubInstall{status: site.InstallStatus{Reason: site.InstallReasonNoSite}}
	r := testRouter(t, Dependencies{SiteResolver: emptySites{}, Install: report})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/setup/status", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"installed":false,"has_admin":false,"reason":"no_site","public_base_url_configured":false}`, w.Body.String())
}

func TestRouterSetupStatusWithoutReporter(t *testing.T) {
	r := testRouter(t, Dependencies{})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/setup/status", nil))

	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.JSONEq(t, `{"installed":false,"reason":"not_configured"}`, w.Body.String())
}

func TestRouterSetupStatusFailureIsProblemJSON(t *testing.T) {
	r := testRouter(t, Dependencies{Install: &stubInstall{err: errors.New("db down")}})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/setup/status", nil))

	require.Equal(t, http.StatusInternalServerError, w.Code)
	require.Equal(t, "application/problem+json", w.Header().Get("Content-Type"))
}
