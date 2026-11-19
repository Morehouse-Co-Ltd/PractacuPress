package middleware

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// CORSConfig is the cross origin policy.
type CORSConfig struct {
	// AllowedOrigins lists exact origins, for example "https://app.example.com".
	// "*" allows any origin, which is only sensible without credentials.
	AllowedOrigins []string
	// AllowCredentials permits cookies on cross origin calls.
	AllowCredentials bool
	// MaxAge is how long a browser may cache a preflight result.
	MaxAge time.Duration
}

// CORS applies the configured cross origin policy.
//
// Only the Allowed-Origin value is echoed back, never a reflected arbitrary origin,
// and preflight requests from an unlisted origin are rejected outright instead of
// being answered with a late browser side failure that is hard to diagnose.
func CORS(cfg CORSConfig) gin.HandlerFunc {
	allowed := make(map[string]struct{}, len(cfg.AllowedOrigins))
	wildcard := false
	for _, origin := range cfg.AllowedOrigins {
		origin = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(origin), "/"))
		if origin == "" {
			continue
		}
		if origin == "*" {
			wildcard = true
			continue
		}
		allowed[origin] = struct{}{}
	}

	maxAge := cfg.MaxAge
	if maxAge <= 0 {
		maxAge = 10 * time.Minute
	}

	return func(c *gin.Context) {
		origin := strings.TrimSpace(c.GetHeader("Origin"))
		if origin == "" {
			c.Next()
			return
		}

		isPreflight := c.Request.Method == http.MethodOptions &&
			c.GetHeader("Access-Control-Request-Method") != ""

		_, exact := allowed[strings.ToLower(strings.TrimSuffix(origin, "/"))]
		if !exact && !wildcard {
			// Do not abort here. The per-site origin list is applied later, after the
			// hostname has selected a site (SiteCORS); a preflight answered with 403
			// now would make a site's own allow-list unreachable whenever the
			// deployment happens to configure any origin at all. Falling through is
			// still a refusal: no CORS headers are written, so the browser blocks the
			// call, and an OPTIONS request only reaches a handler that explicitly
			// accepts it.
			c.Next()
			return
		}

		header := c.Writer.Header()
		header.Add("Vary", "Origin")

		if wildcard && !cfg.AllowCredentials {
			header.Set("Access-Control-Allow-Origin", "*")
		} else {
			// With credentials the origin must be echoed exactly; "*" is invalid.
			header.Set("Access-Control-Allow-Origin", origin)
			header.Add("Vary", "Access-Control-Request-Method")
			header.Add("Vary", "Access-Control-Request-Headers")
		}

		if cfg.AllowCredentials {
			header.Set("Access-Control-Allow-Credentials", "true")
		}
		header.Set("Access-Control-Expose-Headers", HeaderRequestID)

		if isPreflight {
			header.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			// X-Visit-Session is the anonymous de-duplication hint of the read counter
			// (FSD A-16): a browser only sends it when the preflight allows it, so it
			// must be listed here or a cross origin reader's read is never counted.
			header.Set("Access-Control-Allow-Headers",
				"Authorization, Content-Type, Idempotency-Key, X-CSRF-Token, X-Request-ID, X-Visit-Session")
			header.Set("Access-Control-Max-Age", strconv.Itoa(int(maxAge.Seconds())))
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}
