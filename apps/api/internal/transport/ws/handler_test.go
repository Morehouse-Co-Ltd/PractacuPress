package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// newWSTestServer wires the real handler and routes into an httptest server.
func newWSTestServer(t *testing.T, origins []string) (*httptest.Server, *Handler) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	handler := NewHandler(NewTicketStore(nil), NewHub(), HandlerConfig{OriginPatterns: origins})
	r := gin.New()
	r.Use(gin.Recovery())
	handler.Routes(r, func(c *gin.Context) { c.Next() })

	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, handler
}

// dialWS performs one handshake with a freshly minted ticket and an optional Origin.
func dialWS(t *testing.T, srv *httptest.Server, handler *Handler, origin string) (
	*websocket.Conn, *http.Response, error,
) {
	t.Helper()

	ticket, _, err := handler.tickets.Issue(Ticket{SiteID: "site-1", UserID: "user-1"})
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)

	options := &websocket.DialOptions{}
	if origin != "" {
		options.HTTPHeader = http.Header{"Origin": []string{origin}}
	}
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?ticket=" + ticket
	return websocket.Dial(ctx, wsURL, options)
}

// serverHost is the host:port the test server listens on, which is also the request
// Host the handler sees.
func serverHost(srv *httptest.Server) string {
	return strings.TrimPrefix(srv.URL, "http://")
}

// TestWebSocketAcceptsSameOrigin is the V-07 regression: without explicit origin
// patterns a same-origin handshake keeps working.
func TestWebSocketAcceptsSameOrigin(t *testing.T) {
	srv, handler := newWSTestServer(t, nil)

	conn, _, err := dialWS(t, srv, handler, "http://"+serverHost(srv))
	require.NoError(t, err)
	defer conn.CloseNow()
}

// TestWebSocketRejectsForeignOrigin is the exploit from the report: an evil site's
// Origin must be refused when no allow list is configured.
func TestWebSocketRejectsForeignOrigin(t *testing.T) {
	srv, handler := newWSTestServer(t, nil)

	conn, resp, err := dialWS(t, srv, handler, "http://evil.example")
	if conn != nil {
		_ = conn.CloseNow()
	}
	require.Error(t, err, "a cross-origin handshake must not be upgraded")
	require.NotNil(t, resp)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
}

// TestWebSocketAllowsMissingOrigin keeps native clients usable: a caller that is not a
// browser sends no Origin and has a non-forgeable ticket, so it is accepted.
func TestWebSocketAllowsMissingOrigin(t *testing.T) {
	srv, handler := newWSTestServer(t, nil)

	conn, _, err := dialWS(t, srv, handler, "")
	require.NoError(t, err)
	defer conn.CloseNow()
}

// TestWebSocketHonoursConfiguredOriginPatterns proves an explicit allow list still opts
// into cross-origin sockets while everything else stays blocked.
func TestWebSocketHonoursConfiguredOriginPatterns(t *testing.T) {
	srv, handler := newWSTestServer(t, []string{"allowed.example"})

	allowed, _, err := dialWS(t, srv, handler, "https://allowed.example")
	require.NoError(t, err)
	defer allowed.CloseNow()

	foreign, resp, err := dialWS(t, srv, handler, "http://evil.example")
	if foreign != nil {
		_ = foreign.CloseNow()
	}
	require.Error(t, err)
	require.NotNil(t, resp)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)

	// The request host itself is always authorized, allow list or not.
	sameOrigin, _, err := dialWS(t, srv, handler, "http://"+serverHost(srv))
	require.NoError(t, err)
	defer sameOrigin.CloseNow()
}
