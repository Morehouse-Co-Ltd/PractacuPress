package middleware

import (
	"log/slog"
	"net/http"
	"runtime/debug"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/errors"
)

// Recovery converts a panic into a problem+json 500.
//
// Gin's built in Recovery writes an empty body, which breaks the contract that every
// error carries a stable code. The stack trace is logged, never returned: it is
// reconnaissance for an attacker and noise for a client.
func Recovery(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}

			// A client that disconnects mid-write triggers this sentinel; it is not a
			// server fault and must not be logged as one.
			if recovered == http.ErrAbortHandler {
				panic(recovered)
			}

			if logger != nil {
				logger.Error("panic recovered",
					"request_id", RequestIDFrom(c),
					"method", c.Request.Method,
					"path", c.Request.URL.Path,
					"panic", recovered,
					"stack", string(debug.Stack()),
				)
			}

			if c.Writer.Written() {
				c.Abort()
				return
			}

			AbortProblem(c, apperr.Internal(nil).
				WithDetail("reason", "panic").
				WithRequestID(RequestIDFrom(c)))
		}()

		c.Next()
	}
}
