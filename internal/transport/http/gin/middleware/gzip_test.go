package middleware

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/errors"
)

// gunzip decodes a response body, failing the test when the bytes are not a gzip stream.
func gunzip(t *testing.T, body io.Reader) string {
	t.Helper()
	reader, err := gzip.NewReader(body)
	require.NoError(t, err, "response is not valid gzip")
	defer reader.Close()
	decoded, err := io.ReadAll(reader)
	require.NoError(t, err, "read gzip body")
	return string(decoded)
}

func TestGzipCompressesJSON(t *testing.T) {
	engine := newEngine(Gzip())
	engine.GET("/api/v1/x", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"body": strings.Repeat("设计", 500)})
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/x", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := serve(engine, req)

	require.Equal(t, "gzip", rec.Header().Get("Content-Encoding"))
	require.Contains(t, rec.Header().Get("Vary"), "Accept-Encoding")
	require.Empty(t, rec.Header().Get("Content-Length"), "the compressed length is not known up front")

	body := gunzip(t, rec.Body)
	require.Contains(t, body, "设计")
	var payload map[string]any
	require.NoError(t, json.Unmarshal([]byte(body), &payload))
}

// TestGzipCompressesStringBody pins the writer's WriteString path: the site design
// document is served through c.String in a couple of bootstrap routes, and a promoted
// WriteString would bypass the compressor while the header still claimed gzip.
func TestGzipCompressesStringBody(t *testing.T) {
	engine := newEngine(Gzip())
	engine.GET("/api/v1/text", func(c *gin.Context) {
		c.String(http.StatusOK, strings.Repeat("design", 500))
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/text", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := serve(engine, req)

	require.Equal(t, "gzip", rec.Header().Get("Content-Encoding"))
	require.Equal(t, strings.Repeat("design", 500), gunzip(t, rec.Body))
}

func TestGzipSkipsWhenNotAccepted(t *testing.T) {
	engine := newEngine(Gzip())
	engine.GET("/api/v1/x", func(c *gin.Context) { c.String(http.StatusOK, "plain") })

	rec := serve(engine, httptest.NewRequest(http.MethodGet, "/api/v1/x", nil))

	require.Empty(t, rec.Header().Get("Content-Encoding"))
	require.Equal(t, "plain", rec.Body.String())
}

// TestGzipSkipsLongLivedAndBinaryRoutes covers every path the middleware must not
// touch: the event stream and its REST catch-up, the websocket upgrade, and media
// downloads, whose bytes are already compressed and whose body is streamed.
func TestGzipSkipsLongLivedAndBinaryRoutes(t *testing.T) {
	engine := newEngine(Gzip())
	handler := func(c *gin.Context) { c.String(http.StatusOK, "stream") }
	for _, path := range []string{
		"/api/v1/events",
		"/api/v1/events/stream",
		"/api/v1/ws",
		"/api/v1/media/asset_1",
	} {
		engine.GET(path, handler)
	}
	engine.GET("/upgraded", handler)

	for _, path := range []string{
		"/api/v1/events",
		"/api/v1/events/stream",
		"/api/v1/ws",
		"/api/v1/media/asset_1",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Accept-Encoding", "gzip")
		rec := serve(engine, req)
		require.Empty(t, rec.Header().Get("Content-Encoding"), path)
		require.Equal(t, "stream", rec.Body.String(), path)
	}

	// A connection that is about to be hijacked must never be wrapped: the compressor
	// would keep the handshake in its buffer.
	req := httptest.NewRequest(http.MethodGet, "/upgraded", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Upgrade", "websocket")
	require.Empty(t, serve(engine, req).Header().Get("Content-Encoding"))
}

// TestGzipSkipsBodylessResponses is the live interaction with the design document's
// 304: a body-less status that still advertised a gzip encoded body would make the
// response undecodable, and a 204 with Content-Encoding violates the HTTP spec.
func TestGzipSkipsBodylessResponses(t *testing.T) {
	engine := newEngine(Gzip())
	engine.GET("/no-content", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	engine.GET("/not-modified", func(c *gin.Context) {
		c.Header("ETag", `"7-abc"`)
		c.Status(http.StatusNotModified)
	})
	// A handler that confirms a body-bearing status but writes nothing must not claim
	// an encoding either.
	engine.GET("/empty-ok", func(c *gin.Context) { c.Status(http.StatusOK) })

	for _, tc := range []struct {
		path string
		code int
	}{
		{"/no-content", http.StatusNoContent},
		{"/not-modified", http.StatusNotModified},
		{"/empty-ok", http.StatusOK},
	} {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		req.Header.Set("Accept-Encoding", "gzip")
		rec := serve(engine, req)

		require.Equal(t, tc.code, rec.Code, tc.path)
		require.Empty(t, rec.Header().Get("Content-Encoding"), tc.path)
		require.Empty(t, rec.Body.String(), tc.path)
	}

	req := httptest.NewRequest(http.MethodGet, "/not-modified", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := serve(engine, req)
	require.Equal(t, `"7-abc"`, rec.Header().Get("ETag"), "the validator must survive compression")
}

// TestGzipCompressesProblemResponses keeps the API error model readable when the
// compressor wraps the translator: the problem body written after the handler chain is
// still encoded as one stream.
func TestGzipCompressesProblemResponses(t *testing.T) {
	engine := newEngine(Gzip(), ErrorHandler(nil))
	engine.GET("/deny", func(c *gin.Context) { _ = c.Error(apperr.PermissionDenied()) })

	req := httptest.NewRequest(http.MethodGet, "/deny", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := serve(engine, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "gzip", rec.Header().Get("Content-Encoding"))

	var payload map[string]any
	require.NoError(t, json.Unmarshal([]byte(gunzip(t, rec.Body)), &payload))
	require.Equal(t, "permission_denied", payload["code"])
}

// TestGzipLateWriteAfterCloseIsPlain pins the ordering hazard of the real engine, where
// the error translator is registered outside the compressor: it writes the problem body
// after the compressor has finished. The response must then be readable - either encoded
// or plainly written - never a gzip header over unencoded bytes.
func TestGzipLateWriteAfterCloseIsPlain(t *testing.T) {
	engine := newEngine(RequestID(), ErrorHandler(nil), Gzip())
	engine.GET("/deny", func(c *gin.Context) { _ = c.Error(apperr.PermissionDenied()) })

	req := httptest.NewRequest(http.MethodGet, "/deny", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := serve(engine, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Empty(t, rec.Header().Get("Content-Encoding"))
	require.Equal(t, "permission_denied", decodeProblem(t, rec.Body.Bytes())["code"])
}

// TestGzipPanicResponseIsReadable covers the second outer writer: the recovery
// middleware answers a panic after the compressor has been unwound, and a truncated
// encoded stream would hide the problem code from the client.
func TestGzipPanicResponseIsReadable(t *testing.T) {
	engine := newEngine(ErrorHandler(nil), Recovery(nil), Gzip())
	engine.GET("/boom", func(c *gin.Context) { panic("kaboom") })

	req := httptest.NewRequest(http.MethodGet, "/boom", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := serve(engine, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)

	body := rec.Body.String()
	if rec.Header().Get("Content-Encoding") == "gzip" {
		body = gunzip(t, rec.Body)
	}
	require.Equal(t, "internal", decodeProblem(t, []byte(body))["code"])
}

// TestGzipKeepsWrittenTrue stops the error translator from replacing a response that
// the handler already wrote: the compressed bytes sit in the deflate buffer, so only an
// explicit header flush keeps Written() honest.
func TestGzipKeepsWrittenTrue(t *testing.T) {
	engine := newEngine(ErrorHandler(nil), Gzip())
	engine.GET("/partial", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
		_ = c.Error(apperr.Internal(nil))
	})

	req := httptest.NewRequest(http.MethodGet, "/partial", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := serve(engine, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"ok":true}`, gunzip(t, rec.Body))
}
