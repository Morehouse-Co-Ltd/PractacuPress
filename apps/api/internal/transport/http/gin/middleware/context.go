package middleware

import (
	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Context keys. Gin stores values under string keys, so they are namespaced to
// avoid colliding with keys set by other middleware or by tests.
const (
	keyRequestID = "practacu.request_id"
	keySite      = "practacu.site"
)

// RequestIDFrom returns the correlation id assigned to this request.
func RequestIDFrom(c *gin.Context) string {
	if v, ok := c.Get(keyRequestID); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// SiteFrom returns the site resolved for this request.
//
// The second return value is false for routes mounted outside host resolution.
func SiteFrom(c *gin.Context) (site.Site, bool) {
	v, ok := c.Get(keySite)
	if !ok {
		return site.Site{}, false
	}
	s, ok := v.(site.Site)
	return s, ok
}

func withRequestID(c *gin.Context, id string) { c.Set(keyRequestID, id) }

func withSite(c *gin.Context, s site.Site) { c.Set(keySite, s) }
