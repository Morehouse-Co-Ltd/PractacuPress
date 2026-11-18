package ginrouter

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
)

// Step-up re-authentication on the high threat routes.
//
// The module handlers own their authorization; this guard only enforces one extra
// condition the site can switch on: for the routes that delete or rewrite accounts
// and policy data, the request must also carry a fresh proof that the caller knows
// the password. The proof is a short lived `X-PP-Step-Up` grant minted by
// POST /auth/step-up.
//
// The guard sits immediately after the authentication guard in the route chain, so
// the principal and its site are already resolved. Protection is per site: a site
// that never enabled it (the default) lets every request through unchanged.

// StepUpEnforcer answers the two questions the guard asks.
//
// *site.Service implements it: StepUpEnabled reads the site's stored configuration
// and VerifyStepUpToken checks the HMAC grant. Keeping it an interface means the
// transport does not import the signer's key material.
type StepUpEnforcer interface {
	// StepUpEnabled reports whether siteID requires a grant.
	StepUpEnabled(ctx context.Context, siteID string) (bool, error)
	// VerifyStepUpToken reports whether raw is a valid grant for userID on siteID.
	VerifyStepUpToken(raw, userID, siteID string) bool
}

// StepUpDependencies is the optional step-up wiring of the router.
//
// A nil Enforcer leaves every route exactly as it was: the guard is still mounted
// (that keeps the route chains identical everywhere) but is a no-op.
type StepUpDependencies struct {
	Enforcer StepUpEnforcer
}

// stepUpRoute is one protected method + path pair. Paths are gin's route templates,
// the same strings Context.FullPath returns inside a handler.
type stepUpRoute struct {
	Method string
	Path   string
}

// stepUpProtectedRoutes is the frozen list of high threat operations.
//
// It is a list rather than a prefix rule on purpose: a new dangerous endpoint must
// be added here explicitly, and a benign one added under the same module is not
// silently dragged behind a password prompt. The list matches the OpenAPI contract
// (each operation documents the X-PP-Step-Up header).
var stepUpProtectedRoutes = map[stepUpRoute]struct{}{
	// Account creation and administration of another account.
	{Method: http.MethodPost, Path: "/api/v1/sites/:siteID/members"}:                   {},
	{Method: http.MethodPatch, Path: "/api/v1/sites/:siteID/members/:userID"}:          {},
	{Method: http.MethodDelete, Path: "/api/v1/sites/:siteID/members/:userID"}:         {},
	{Method: http.MethodPatch, Path: "/api/v1/sites/:siteID/members/:userID/role"}:     {},
	{Method: http.MethodPatch, Path: "/api/v1/sites/:siteID/members/:userID/group"}:    {},
	{Method: http.MethodPatch, Path: "/api/v1/sites/:siteID/members/:userID/status"}:   {},
	{Method: http.MethodPatch, Path: "/api/v1/sites/:siteID/members/:userID/quota"}:    {},
	{Method: http.MethodPost, Path: "/api/v1/sites/:siteID/members/:userID/2fa/reset"}: {},
	// Whole-site import replaces content and settings; deleting policy data changes
	// enforcement for every visitor.
	{Method: http.MethodPost, Path: "/api/v1/sites/:siteID/import"}:                    {},
	{Method: http.MethodDelete, Path: "/api/v1/sites/:siteID/safety/words/:wordID"}:    {},
	{Method: http.MethodDelete, Path: "/api/v1/sites/:siteID/safety/ip-rules/:ruleID"}: {},
}

// isStepUpProtected reports whether this request is one of the high threat routes.
func isStepUpProtected(method, fullPath string) bool {
	if fullPath == "" {
		return false
	}
	_, ok := stepUpProtectedRoutes[stepUpRoute{Method: method, Path: fullPath}]
	return ok
}

// StepUpGuard enforces the site's re-authentication switch on the protected routes.
//
// It must be mounted after the authentication guard. Every failure is a Problem:
// a disabled feature costs no database read beyond the setting lookup, and a site
// whose setting cannot be read fails closed with 500 instead of silently skipping
// the password prompt.
func StepUpGuard(enforcer StepUpEnforcer) gin.HandlerFunc {
	if enforcer == nil {
		return func(c *gin.Context) { c.Next() }
	}
	return func(c *gin.Context) {
		if !isStepUpProtected(c.Request.Method, c.FullPath()) {
			c.Next()
			return
		}

		principal, ok := middleware.PrincipalFrom(c)
		if !ok || principal.UserID == "" {
			middleware.AbortProblem(c, apperr.Unauthenticated().
				WithDetail("reason", "missing_principal").
				WithRequestID(middleware.RequestIDFrom(c)))
			return
		}

		// The path site is what the operation acts on. The authentication guard has
		// already rejected a token minted for another site, so the two agree; the path
		// is still preferred because it is the value the handler will use.
		siteID := principal.SiteID
		if pathSiteID := c.Param("siteID"); pathSiteID != "" {
			siteID = pathSiteID
		}

		enabled, err := enforcer.StepUpEnabled(c.Request.Context(), siteID)
		if err != nil {
			middleware.AbortProblem(c, apperr.Internal(err).
				WithRequestID(middleware.RequestIDFrom(c)))
			return
		}
		if !enabled {
			c.Next()
			return
		}

		if !enforcer.VerifyStepUpToken(c.GetHeader(site.StepUpHeaderName), principal.UserID, siteID) {
			middleware.AbortProblem(c, apperr.PermissionDenied().
				WithDetail("reason", "step_up_required").
				WithRequestID(middleware.RequestIDFrom(c)))
			return
		}
		c.Next()
	}
}
