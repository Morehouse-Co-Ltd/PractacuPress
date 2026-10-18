package ginrouter

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
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

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"status":"ok"}`, w.Body.String())
}

func TestRouterHealthzIgnoresReadiness(t *testing.T) {
	r := testRouter(t, Dependencies{
		Readiness: func(context.Context) error { return errors.New("db down") },
	})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	require.Equal(t, http.StatusOK, w.Code)
}

func TestRouterReadyzDefault(t *testing.T) {
	r := testRouter(t, Dependencies{})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"status":"ready"}`, w.Body.String())
}

func TestRouterReadyzUnready(t *testing.T) {
	r := testRouter(t, Dependencies{
		Readiness: func(context.Context) error { return errors.New("db down") },
	})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.JSONEq(t, `{"status":"unready"}`, w.Body.String())
}

func TestRouterOpenAPIAvailableWithoutSession(t *testing.T) {
	r := testRouter(t, Dependencies{})
	w := httptest.NewRecorder()

	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"openapi":"3.1.0"`)
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
