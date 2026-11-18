package middleware

import (
	"log/slog"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/errors"
)

// ErrorHandler converts handler errors into application/problem+json responses.
//
// Handlers and services report failures with c.Error; only this middleware decides
// the status code, and only it decides what reaches the client. Anything that is
// not already a Problem becomes an opaque 500, and the original error is kept for
// the log only.
func ErrorHandler(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()

		if len(c.Errors) == 0 {
			return
		}

		problem := apperr.FromError(c.Errors.Last().Err)
		if problem.RequestID == "" {
			problem.RequestID = RequestIDFrom(c)
		}

		logProblem(logger, c, problem)

		// A handler that already wrote a body keeps it; rewriting here would emit
		// two responses on one connection.
		if c.Writer.Written() {
			return
		}
		AbortProblem(c, problem)
	}
}

func logProblem(logger *slog.Logger, c *gin.Context, problem *apperr.Problem) {
	if logger == nil {
		return
	}

	attrs := []any{
		"code", string(problem.Code),
		"status", problem.Status,
		"request_id", problem.RequestID,
		"method", c.Request.Method,
		"path", c.Request.URL.Path,
	}
	if cause := problem.Cause(); cause != nil {
		attrs = append(attrs, "cause", cause.Error())
	}

	if problem.Status >= 500 {
		logger.Error("request failed", attrs...)
		return
	}
	logger.Warn("request rejected", attrs...)
}
