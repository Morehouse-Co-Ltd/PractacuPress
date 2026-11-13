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

func TestAllowFirstAdminFromLoopbackRejectsMissingRequest(t *testing.T) {
	require.False(t, AllowFirstAdminFromLoopback(nil))
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	require.False(t, AllowFirstAdminFromLoopback(c))
}
