package middleware

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// RequestTimeout bounds how long one request may keep working.
//
// Two different resources are at stake. The context deadline cancels the request's work,
// which is what frees the database connection a stuck handler would otherwise pin; the
// write deadline is what stops a client that never reads its response from blocking the
// handler inside Write. Both are needed: the first bounds the work, the second bounds the
// delivery.
//
// The server deliberately configures no global WriteTimeout, because the WebSocket link
// and media downloads are long lived and a server wide deadline would sever them.
// Per-request deadlines let those two stay exempt while everything else is bounded.
func RequestTimeout(d time.Duration, exempt func(*gin.Context) bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		if d <= 0 || (exempt != nil && exempt(c)) {
			c.Next()
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), d)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)

		// The write deadline is absolute and lives on the connection, so it is cleared
		// on the way out: leaving it behind would make the next request on the same
		// keep-alive connection inherit a deadline that may already be in the past.
		// Not every ResponseWriter supports it (gin's wrapper may not expose the
		// underlying connection); ErrNotSupported is fine, the context deadline still
		// applies.
		controller := http.NewResponseController(c.Writer)
		_ = controller.SetWriteDeadline(time.Now().Add(d))
		defer func() { _ = controller.SetWriteDeadline(time.Time{}) }()

		c.Next()
	}
}

// LongLivedRequests is the default exemption set: upgraded connections and streaming
// downloads. Both are legitimately slow and both would be cut off by a deadline.
func LongLivedRequests(c *gin.Context) bool {
	path := c.Request.URL.Path
	// Only the socket actually upgrades. The header alone is client controlled: a
	// request to an expensive route could otherwise opt out of the deadline (and hold
	// a pooled database connection) just by sending "Upgrade: h2c".
	if c.Request.Header.Get("Upgrade") != "" && strings.HasPrefix(path, "/api/v1/ws") {
		return true
	}
	if strings.HasPrefix(path, "/api/v1/ws") || strings.HasPrefix(path, "/api/v1/media/") {
		return true
	}
	// Backup creation, site export and site import are bulk file operations; the
	// ordinary request budget would cut a large package off mid-transfer.
	if strings.HasPrefix(path, "/api/v1/platform/backups") ||
		strings.HasSuffix(path, "/export") || strings.HasSuffix(path, "/import") {
		return true
	}
	return false
}
