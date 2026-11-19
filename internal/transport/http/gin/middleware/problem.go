package middleware

import (
	"encoding/json"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/errors"
)

// WriteProblem serializes p as application/problem+json.
//
// It does not abort the handler chain; use AbortProblem for that.
func WriteProblem(c *gin.Context, p *apperr.Problem) {
	c.Header("Content-Type", apperr.ContentType)
	c.Status(p.Status)
	enc := json.NewEncoder(c.Writer)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(p)
}

// AbortProblem writes p and stops the remaining handlers.
func AbortProblem(c *gin.Context, p *apperr.Problem) {
	WriteProblem(c, p)
	c.Abort()
}
