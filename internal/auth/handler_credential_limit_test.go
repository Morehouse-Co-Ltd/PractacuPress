package auth_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
)

// TestCredentialEndpointsAreBehindTheStricterLimiter is the regression test for the
// login-burst finding: the endpoints that consume a password must charge the dedicated
// budget, so a credential stuffing run cannot reach the Argon2 cost more often than that
// budget allows. The handler is nil on purpose - the limiter aborts before it runs, so a
// 429 proves the middleware order is right.
func TestCredentialEndpointsAreBehindTheStricterLimiter(t *testing.T) {
	gin.SetMode(gin.TestMode)

	rejected := func(c *gin.Context) {
		middleware.AbortProblem(c, apperr.RateLimited())
	}

	handler := auth.NewHandler(nil, auth.HandlerConfig{CredentialLimiter: rejected})
	r := gin.New()
	r.Use(middleware.RequestID(), middleware.ErrorHandler(nil))
	handler.Routes(r, func(c *gin.Context) { c.Next() })

	for _, route := range []string{
		"/auth/register/email",
		"/auth/login/password",
		"/auth/password-reset/request",
		"/auth/password-reset/confirm",
	} {
		req := httptest.NewRequest(http.MethodPost, route, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		require.Equal(t, http.StatusTooManyRequests, w.Code,
			"%s must charge the credential budget", route)
	}
}

// TestRefreshAndLogoutAreNotCharged keeps the tier from breaking the session lifecycle:
// refresh runs on a timer in every open tab and must not compete with login for budget,
// and logout must always be reachable so a lockout cannot trap a user in a session.
func TestRefreshAndLogoutAreNotCharged(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var charged int
	counter := func(c *gin.Context) {
		charged++
		c.Next()
	}

	handler := auth.NewHandler(nil, auth.HandlerConfig{CredentialLimiter: counter})
	r := gin.New()
	r.Use(middleware.RequestID(), middleware.ErrorHandler(nil), gin.Recovery())
	handler.Routes(r, func(c *gin.Context) { c.Next() })

	for _, route := range []string{"/auth/token/refresh", "/auth/logout"} {
		req := httptest.NewRequest(http.MethodPost, route, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		require.NotEqual(t, http.StatusTooManyRequests, w.Code,
			"%s must not charge the credential budget", route)
	}
	require.Equal(t, 0, charged, "refresh and logout must bypass the credential tier")
}
