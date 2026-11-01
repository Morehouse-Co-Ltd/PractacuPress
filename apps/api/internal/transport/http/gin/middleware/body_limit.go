package middleware

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

// BodyLimitRule gives one path prefix its own ceiling.
//
// Multipart uploads are the only legitimate large body in this API, so the rules exist to
// let that one route carry a bigger number than everything else.
type BodyLimitRule struct {
	// Prefix matches the request path by prefix, for example "/api/v1/media/uploads/".
	Prefix string
	// Limit is the ceiling in bytes for requests matching Prefix.
	Limit int64
}

// BodyLimit caps how many bytes a handler may read from a request body.
//
// Without a cap, a multipart upload is spooled to disk (or memory) in full before any
// handler looks at its declared size, so one authenticated client can fill the disk. The
// reader refuses bytes past the limit instead: a body that keeps arriving is cut off
// mid-read and the handler's own read reports the failure.
//
// A non-positive default disables the middleware; individual rules still apply.
func BodyLimit(defaultLimit int64, rules ...BodyLimitRule) gin.HandlerFunc {
	limits := make([]BodyLimitRule, 0, len(rules))
	for _, rule := range rules {
		if rule.Prefix != "" && rule.Limit > 0 {
			limits = append(limits, rule)
		}
	}

	return func(c *gin.Context) {
		limit := defaultLimit
		path := c.Request.URL.Path
		for _, rule := range limits {
			if len(path) >= len(rule.Prefix) && path[:len(rule.Prefix)] == rule.Prefix {
				limit = rule.Limit
				break
			}
		}

		if limit > 0 && c.Request.Body != nil {
			// MaxBytesReader also stops the server from reusing the connection, so a
			// client that ignores the cutoff cannot keep the socket busy.
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}

// IsBodyTooLarge reports whether err came from the body ceiling.
//
// Handlers use it to answer "payload too large" instead of the generic parse error their
// reader would otherwise produce for a truncated body.
func IsBodyTooLarge(err error) bool {
	var tooLarge *http.MaxBytesError
	return errors.As(err, &tooLarge)
}
