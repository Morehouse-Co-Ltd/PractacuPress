package middleware

import "github.com/gin-gonic/gin"

// ContentSecurityPolicy is the browser policy for the embedded frontend.
//
// The API itself only writes JSON, but the same process serves the SPA when the
// frontend is embedded. The captcha and page-builder preview capabilities need
// the slightly wider script/frame sources; every other directive stays
// same-origin. Keep this string byte-identical to
// deploy/linux/nginx/locations.conf.in; the deployment header test compares both copies.
const ContentSecurityPolicy = "default-src 'self'; img-src 'self' data: https:; " +
	"font-src 'self' data:; style-src 'self' 'unsafe-inline' " +
	"https://challenges.cloudflare.com https://*.hcaptcha.com https://www.gstatic.com; " +
	"script-src 'self' https://challenges.cloudflare.com https://js.hcaptcha.com " +
	"https://www.google.com https://www.gstatic.com; " +
	"frame-src 'self' https: http:; " +
	"connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com https://www.google.com; " +
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
