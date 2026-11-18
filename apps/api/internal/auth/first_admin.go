package auth

import (
	"net"
	"strings"

	"github.com/gin-gonic/gin"
)

// FirstAdminFunc decides whether the current request may claim the install's first
// account, which the desktop bootstrap promotes to platform administrator.
//
// It exists so the transport layer can impose request scoped rules (the loopback
// requirement) without the auth service knowing anything about HTTP.
type FirstAdminFunc func(*gin.Context) bool

// AllowFirstAdminFromLoopback is the safe implementation of FirstAdminFunc: the first
// administrator may only be created by a caller that reached the API from this machine.
//
// This is the API side of the "expose first, install later" fix: a fresh install that
// is reachable over the network must not let whoever connects first become the
// platform administrator. The desktop launcher binds loopback and proxies to the API,
// so its setup wizard still works; a reverse proxy that publishes a not yet claimed
// instance leaves registration possible for plain members but not for the owner role.
//
// Both checks are required: the Host header alone is attacker controlled on a direct
// connection (any client can send "Host: 127.0.0.1"), and the socket peer alone is a
// proxy for every request that arrives through one. Gin's ClientIP resolves the
// forwarding chain only through peers listed in TRUSTED_PROXIES and falls back to the
// socket address otherwise, which is exactly the trust decision the rate limiter and
// site resolution already use. The first admin claim needs a loopback client *and* a
// loopback Host.
func AllowFirstAdminFromLoopback(c *gin.Context) bool {
	if c == nil || c.Request == nil {
		return false
	}
	if !isLoopbackHost(c.Request.Host) {
		return false
	}
	return isLoopbackPeer(c.ClientIP())
}

// AllowFirstAdminFromLocalProxy is the Docker single-host variant.
//
// The default compose file publishes the site on 127.0.0.1 only, and Docker's port
// NAT hides the real client address: every request arrives from the bridge gateway,
// so the loopback-peer check above can never pass even when the visitor is sitting
// at the machine. Requiring a loopback Host is the remaining signal, and it is only
// sound while the published port itself is loopback-bound. The composition root
// enables this only for PP_DESKTOP with PP_FIRST_ADMIN_TRUST_PROXY=1; do not set
// that variable on a deployment reachable from the network, or the first visitor
// can claim the administrator seat.
func AllowFirstAdminFromLocalProxy(c *gin.Context) bool {
	if c == nil || c.Request == nil {
		return false
	}
	return isLoopbackHost(c.Request.Host)
}

// isLoopbackPeer reports whether an address (bare IP or host:port) is this machine.
func isLoopbackPeer(remoteAddr string) bool {
	host := remoteAddr
	if parsed, _, err := net.SplitHostPort(remoteAddr); err == nil {
		host = parsed
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// isLoopbackHost reports whether a Host header value names this machine.
//
// The port is ignored: the launcher, a reverse proxy and the API itself may each
// rewrite it.
func isLoopbackHost(hostPort string) bool {
	host := hostOnly(hostPort)
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
