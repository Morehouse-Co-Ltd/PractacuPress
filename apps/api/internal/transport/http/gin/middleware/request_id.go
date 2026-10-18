package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// HeaderRequestID is the request correlation header, both inbound and outbound.
const HeaderRequestID = "X-Request-ID"

// maxRequestIDLen bounds client supplied ids so they cannot be used to bloat logs.
const maxRequestIDLen = 64

// RequestID assigns every request a correlation id.
//
// A well formed inbound id is reused so a client or edge proxy can trace a call;
// anything malformed is replaced rather than rejected, because a bad trace header
// must never fail a request.
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := sanitizeRequestID(c.GetHeader(HeaderRequestID))
		if id == "" {
			id = uuid.Must(uuid.NewV7()).String()
		}
		withRequestID(c, id)
		c.Header(HeaderRequestID, id)
		c.Next()
	}
}

func sanitizeRequestID(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > maxRequestIDLen {
		return ""
	}
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.', r == ':':
		default:
			return ""
		}
	}
	return raw
}
