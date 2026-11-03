package middleware

import "github.com/gin-gonic/gin"

// ContentSecurityPolicy is the conservative default policy for API responses.
//
// The API itself only writes JSON, so a strict policy costs nothing; it becomes the
// second line of defence when a deployment serves user HTML through the same origin
// (a misconfigured reverse proxy, an error page, a future server-rendered route).
// `style-src 'unsafe-inline'` is required for the SPA's inline theme variables and
// sandboxed extension frames; script stays same-origin only.
const ContentSecurityPolicy = "default-src 'self'; img-src 'self' data: https:; " +
	"style-src 'self' 'unsafe-inline'; script-src 'self'; " +
	"frame-ancestors 'self'; base-uri 'self'; form-action 'self'"

// PermissionsPolicy minimally disables powerful browser features nobody on the site
// asked for. New features default to allow-listed for the origin, so the list only
// needs the sensors that could be abused by embedded content.
const PermissionsPolicy = "camera=(), microphone=(), geolocation=()"

// SecurityHeaders applies the browser security headers to every response.
//
// It runs before the handlers so error and abort responses carry the headers too:
// a clickjacking or sniffing protection that only covers 200s protects nothing.
// HSTS is intentionally absent: this process may be reached over plain HTTP on
// loopback, and the header is only meaningful once TLS is configured in front.
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.Writer.Header()
		header.Set("Content-Security-Policy", ContentSecurityPolicy)
		header.Set("X-Frame-Options", "SAMEORIGIN")
		header.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		header.Set("Permissions-Policy", PermissionsPolicy)
		header.Set("X-Content-Type-Options", "nosniff")
		c.Next()
	}
}
