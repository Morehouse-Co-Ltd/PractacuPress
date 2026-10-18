package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

func TestRecoveryTurnsPanicIntoProblemJSON(t *testing.T) {
	r := newEngine(RequestID(), Recovery(nil))
	r.GET("/boom", func(*gin.Context) { panic("kaboom") })

	w := serve(r, httptest.NewRequest(http.MethodGet, "/boom", nil))

	require.Equal(t, http.StatusInternalServerError, w.Code)
	require.Equal(t, apperr.ContentType, w.Header().Get("Content-Type"))

	payload := decodeProblem(t, w.Body.Bytes())
	require.Equal(t, "internal", payload["code"])
	require.Equal(t, "panic", payload["details"].(map[string]any)["reason"])
	require.NotEmpty(t, payload["request_id"])
	require.NotContains(t, w.Body.String(), "kaboom", "the panic value must not reach the client")
}

func TestRecoveryLeavesSuccessfulRequestsAlone(t *testing.T) {
	r := newEngine(RequestID(), Recovery(nil))
	r.GET("/ok", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	w := serve(r, httptest.NewRequest(http.MethodGet, "/ok", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"ok":true}`, w.Body.String())
}

func TestRecoveryDoesNotRewriteWrittenResponse(t *testing.T) {
	r := newEngine(RequestID(), Recovery(nil))
	r.GET("/partial", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
		panic("after write")
	})

	w := serve(r, httptest.NewRequest(http.MethodGet, "/partial", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"ok":true}`, w.Body.String())
}
