package ginrouter

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

// gunzipBody decodes a response body, tolerating an unencoded one.
func gunzipBody(t *testing.T, body []byte, encoding string) string {
	t.Helper()
	if encoding != "gzip" {
		return string(body)
	}
	reader, err := gzip.NewReader(bytes.NewReader(body))
	require.NoError(t, err)
	defer reader.Close()
	decoded, err := io.ReadAll(reader)
	require.NoError(t, err)
	return string(decoded)
}

// TestRouterCompressesJSON pins the registration itself: the engine must compress for a
// client that accepts gzip, because the desktop build reaches this process with no proxy
// in between to do it.
func TestRouterCompressesJSON(t *testing.T) {
	r := testRouter(t, Dependencies{})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, "gzip", w.Header().Get("Content-Encoding"))
	require.JSONEq(t, `{"status":"ok"}`, gunzipBody(t, w.Body.Bytes(), "gzip"))
}

// TestRouterErrorStaysReadableWhenCompressed exercises the real middleware order: the
// error translator sits outside the compressor, so the problem body is written once the
// compression stage has finished. Whatever encoding the response claims, it has to parse.
func TestRouterErrorStaysReadableWhenCompressed(t *testing.T) {
	r := testRouter(t, Dependencies{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/nope", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusNotFound, w.Code)
	body := gunzipBody(t, w.Body.Bytes(), w.Header().Get("Content-Encoding"))
	require.Contains(t, body, `"code":"not_found"`)
}
