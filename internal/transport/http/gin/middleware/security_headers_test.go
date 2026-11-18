package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/errors"
)

// TestSecurityHeadersSetsThePolicyOnSuccess is the V-05 regression test: every API
// response must carry the clickjacking / sniffing / referrer policy, not just HTML.
func TestSecurityHeadersSetsThePolicyOnSuccess(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := newEngine(SecurityHeaders())
	r.GET("/x", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	w := serve(r, httptest.NewRequest(http.MethodGet, "/x", nil))

	require.Equal(t, http.StatusOK, w.Code)
	header := w.Header()
	require.Equal(t, ContentSecurityPolicy, header.Get("Content-Security-Policy"))
	require.Contains(t, header.Get("Content-Security-Policy"), "default-src 'self'")
	require.Contains(t, header.Get("Content-Security-Policy"), "frame-ancestors 'self'")
	require.Contains(t, header.Get("Content-Security-Policy"), "base-uri 'self'")
	require.Contains(t, header.Get("Content-Security-Policy"), "form-action 'self'")
	require.Equal(t, "SAMEORIGIN", header.Get("X-Frame-Options"))
	require.Equal(t, "strict-origin-when-cross-origin", header.Get("Referrer-Policy"))
	require.Equal(t, "camera=(), microphone=(), geolocation=()", header.Get("Permissions-Policy"))
	require.Equal(t, "nosniff", header.Get("X-Content-Type-Options"))
	require.Len(t, header.Values("Content-Security-Policy"), 1, "the policy must not be duplicated")
}

// TestSecurityHeadersCoverErrorResponses keeps aborted requests protected too: a
// clickjacking protection that only covers 200s is worthless.
func TestSecurityHeadersCoverErrorResponses(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := newEngine(SecurityHeaders(), ErrorHandler(nil))
	r.GET("/deny", func(c *gin.Context) {
		_ = c.Error(apperr.PermissionDenied())
	})
	r.NoRoute(func(c *gin.Context) { c.Status(http.StatusNotFound) })

	for _, path := range []string{"/deny", "/missing"} {
		w := serve(r, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, "SAMEORIGIN", w.Header().Get("X-Frame-Options"), path)
		require.NotEmpty(t, w.Header().Get("Content-Security-Policy"), path)
		require.Equal(t, "nosniff", w.Header().Get("X-Content-Type-Options"), path)
	}
}

// TestSecurityHeadersDoNotOverrideHandlerHeaders keeps a route free to tighten the
// policy (for example a media download that must not render inline) while the
// middleware still supplies a default for everything else.
func TestSecurityHeadersDoNotOverrideHandlerHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := newEngine(SecurityHeaders())
	r.GET("/x", func(c *gin.Context) {
		c.Header("X-Frame-Options", "DENY")
		c.Status(http.StatusOK)
	})

	w := serve(r, httptest.NewRequest(http.MethodGet, "/x", nil))

	require.Equal(t, "DENY", w.Header().Get("X-Frame-Options"))
}
