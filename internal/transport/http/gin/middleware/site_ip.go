package middleware

import (
	"context"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
)

// IPPolicyChecker decides whether a client address may reach a site.
//
// The safety service implements it. The port keeps this middleware independent of
// the safety package and of its store, so tests can inject a fixed answer.
type IPPolicyChecker interface {
	// AllowsIP reports whether address may reach the host-resolved site.
	AllowsIP(ctx context.Context, siteID, address string) (bool, error)
}

// SiteIPGuard refuses a request whose client address is on the site's deny list, or
// is missing from a non-empty allow list.
//
// It runs after ResolveSite, so the rule set of the host that selected the tenant is
// the one applied; the same address can be refused on one site and accepted on
// another. A policy load failure fails open: the safety table being unavailable must
// not take the whole site offline, and the deny list is an abuse control rather than
// an authentication boundary.
func SiteIPGuard(checker IPPolicyChecker) gin.HandlerFunc {
	return func(c *gin.Context) {
		if checker == nil {
			c.Next()
			return
		}
		resolved, ok := SiteFrom(c)
		if !ok {
			c.Next()
			return
		}

		address := c.ClientIP()
		allowed, err := checker.AllowsIP(c.Request.Context(), resolved.ID, address)
		if err != nil {
			c.Next()
			return
		}
		if !allowed {
			AbortProblem(c, apperr.PermissionDenied().
				WithDetail("reason", "ip_blocked").
				WithDetail("ip", address).
				WithRequestID(RequestIDFrom(c)))
			return
		}
		c.Next()
	}
}
