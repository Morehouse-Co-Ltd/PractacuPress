package middleware

import (
		"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// TestBodyLimitRefusesOversizedBody is the regression test for the unbounded body: the
// reader must refuse bytes past the ceiling instead of spooling them first.
func TestBodyLimitRefusesOversizedBody(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var readErr error
	r := newEngine(BodyLimit(64))
	r.POST("/x", func(c *gin.Context) {
		_, readErr = io.ReadAll(c.Request.Body)
		if readErr != nil {
			c.Status(http.StatusRequestEntityTooLarge)
			return
		}
		c.Status(http.StatusOK)
	})

	body := strings.NewReader(strings.Repeat("a", 4096))
	w := serve(r, httptest.NewRequest(http.MethodPost, "/x", body))

	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code)
	require.Error(t, readErr)
	require.True(t, IsBodyTooLarge(readErr), "the failure must be identifiable")
}

func TestBodyLimitAllowsBodyUnderTheCeiling(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var length int
	r := newEngine(BodyLimit(64))
	r.POST("/x", func(c *gin.Context) {
		data, err := io.ReadAll(c.Request.Body)
		require.NoError(t, err)
		length = len(data)
		c.Status(http.StatusOK)
	})

	w := serve(r, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader("hello")))

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, 5, length)
}

// TestBodyLimitRuleOverridesForUploads keeps the upload route usable while everything else
// stays small.
func TestBodyLimitRuleOverridesForUploads(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := newEngine(BodyLimit(16, BodyLimitRule{Prefix: "/api/v1/media/uploads/", Limit: 4096}))
	read := func(c *gin.Context) {
		if _, err := io.ReadAll(c.Request.Body); err != nil {
			c.Status(http.StatusRequestEntityTooLarge)
			return
		}
		c.Status(http.StatusOK)
	}
	r.POST("/api/v1/media/uploads/:id/content", read)
	r.POST("/api/v1/articles", read)

	big := strings.Repeat("a", 1024)
	require.Equal(t, http.StatusOK, serve(r,
		httptest.NewRequest(http.MethodPost, "/api/v1/media/uploads/u1/content", strings.NewReader(big))).Code)
	require.Equal(t, http.StatusRequestEntityTooLarge, serve(r,
		httptest.NewRequest(http.MethodPost, "/api/v1/articles", strings.NewReader(big))).Code)
}

// TestRequestTimeoutCancelsRequestWork proves the context deadline reaches the handler,
// which is what frees the database connection a stuck query would hold.
func TestRequestTimeoutCancelsRequestWork(t *testing.T) {
	gin.SetMode(gin.TestMode)

	released := make(chan struct{})
	r := newEngine(RequestTimeout(40*time.Millisecond, nil))
	r.GET("/x", func(c *gin.Context) {
		// Stands in for a slow query: it returns only when the request is cancelled.
		<-c.Request.Context().Done()
		close(released)
		c.Status(http.StatusServiceUnavailable)
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		w := serve(r, httptest.NewRequest(http.MethodGet, "/x", nil))
		require.Equal(t, http.StatusServiceUnavailable, w.Code)
	}()

	select {
	case <-released:
	case <-time.After(2 * time.Second):
		t.Fatal("the handler never observed its context deadline")
	}
	<-done
}

// TestRequestTimeoutExemptsLongLivedRequests keeps the socket and media downloads working:
// both are legitimately slow and a deadline would sever them.
func TestRequestTimeoutExemptsLongLivedRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := newEngine(RequestTimeout(20*time.Millisecond, LongLivedRequests))
	r.GET("/api/v1/ws", func(c *gin.Context) {
		time.Sleep(80 * time.Millisecond)
		require.NoError(t, c.Request.Context().Err(), "the socket must not be cancelled")
		c.Status(http.StatusOK)
	})
	r.GET("/api/v1/media/:id", func(c *gin.Context) {
		time.Sleep(80 * time.Millisecond)
		require.NoError(t, c.Request.Context().Err(), "a download must not be cancelled")
		c.Status(http.StatusOK)
	})

	require.Equal(t, http.StatusOK,
		serve(r, httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil)).Code)
	require.Equal(t, http.StatusOK,
		serve(r, httptest.NewRequest(http.MethodGet, "/api/v1/media/a1", nil)).Code)
}

// TestLongLivedRequestsMatchesUpgrades covers the other exemption shape: a request that
// carries an Upgrade header is a protocol switch, whatever its path.
func TestLongLivedRequestsMatchesUpgrades(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := newEngine(RequestTimeout(10*time.Millisecond, LongLivedRequests))
	r.GET("/anything", func(c *gin.Context) {
		time.Sleep(50 * time.Millisecond)
		require.NoError(t, c.Request.Context().Err())
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/anything", nil)
	req.Header.Set("Upgrade", "websocket")
	require.Equal(t, http.StatusOK, serve(r, req).Code)
}

