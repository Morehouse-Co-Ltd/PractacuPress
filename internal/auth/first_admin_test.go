package auth

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// newFirstAdminRequest builds a request context with the given Host header and
// socket peer address.
func newFirstAdminRequest(host, remoteAddr string) *gin.Context {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/api/v1/auth/register/email", nil)
	c.Request.Host = host
	c.Request.RemoteAddr = remoteAddr
	return c
}

func TestAllowFirstAdminFromLoopbackRequiresLoopbackHostAndPeer(t *testing.T) {
	cases := []struct {
		name       string
		host       string
		remoteAddr string
		want       bool
	}{
		{"loopback host and peer", "127.0.0.1:8080", "127.0.0.1:54321", true},
		{"localhost host and peer", "localhost:8080", "127.0.0.1:54321", true},
		{"IPv6 loopback", "[::1]:8080", "[::1]:54321", true},
		{"forged host from remote peer", "127.0.0.1:8080", "203.0.113.9:54321", false},
		{"LAN host from loopback proxy", "192.168.1.20:8080", "127.0.0.1:54321", false},
		{"remote host and peer", "evil.example", "203.0.113.9:54321", false},
		{"empty remote addr", "127.0.0.1:8080", "", false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			c := newFirstAdminRequest(testCase.host, testCase.remoteAddr)
			require.Equal(t, testCase.want, AllowFirstAdminFromLoopback(c))
		})
	}
}

// TestAllowFirstAdminFromLocalProxy covers the Docker opt-in: only the Host is
// checked, which is sound only while the published port is loopback-bound.
func TestAllowFirstAdminFromLocalProxy(t *testing.T) {
	require.True(t, AllowFirstAdminFromLocalProxy(newFirstAdminRequest("localhost:8080", "172.28.0.1:54321")))
	require.False(t, AllowFirstAdminFromLocalProxy(newFirstAdminRequest("press.example.com:443", "172.28.0.1:54321")))
	require.False(t, AllowFirstAdminFromLocalProxy(nil))
}

func TestAllowFirstAdminFromLoopbackRejectsMissingRequest(t *testing.T) {
	require.False(t, AllowFirstAdminFromLoopback(nil))
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	require.False(t, AllowFirstAdminFromLoopback(c))
}

// TestAllowFirstAdminFromLoopbackFollowsTrustedProxyChain covers the Docker
// deployment: the request reaches the API from the Nginx container, and the real
// client address is in X-Forwarded-For. Requiring the socket peer itself to be
// loopback made the documented first-admin bootstrap impossible behind any proxy.
func TestAllowFirstAdminFromLoopbackFollowsTrustedProxyChain(t *testing.T) {
	engine := gin.New()
	require.NoError(t, engine.SetTrustedProxies([]string{"172.28.0.0/16"}))

	request := func(remoteAddr, forwarded string) *gin.Context {
		c := gin.CreateTestContextOnly(httptest.NewRecorder(), engine)
		c.Request = httptest.NewRequest("POST", "/api/v1/auth/register/email", nil)
		c.Request.Host = "localhost:8080"
		c.Request.RemoteAddr = remoteAddr
		if forwarded != "" {
			c.Request.Header.Set("X-Forwarded-For", forwarded)
		}
		return c
	}

	require.True(t, AllowFirstAdminFromLoopback(request("172.28.0.5:4321", "127.0.0.1")),
		"a loopback client behind the trusted proxy may claim the first admin")
	require.False(t, AllowFirstAdminFromLoopback(request("172.28.0.5:4321", "203.0.113.9")),
		"a remote client is still refused")
	require.False(t, AllowFirstAdminFromLoopback(request("203.0.113.9:4321", "127.0.0.1")),
		"an untrusted peer cannot spoof the forwarding header")
}
