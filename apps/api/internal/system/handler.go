package system

import (
	"net/http"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller's role. The system endpoint is a
// deployment-level surface, so the role is the only thing the handler needs.
type PrincipalFunc func(*gin.Context) (role string, ok bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	// Principal resolves the caller. Nil rejects every request.
	Principal PrincipalFunc
}

// Handler serves the resource snapshot of this installation.
type Handler struct {
	latest    func() Snapshot
	principal PrincipalFunc
}

// NewHandler builds a Handler over a snapshot source. A nil source answers 503, which
// is what a deployment that disabled the module should never hit (the route is not
// mounted at all) but still fails closed if something wires it wrong.
func NewHandler(latest func() Snapshot, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (string, bool) { return "", false }
	}
	return &Handler{latest: latest, principal: principal}
}

// Routes mounts the system endpoints under /api/v1.
//
// The route sits behind the normal authentication guard; the platform administrator
// check happens in the handler because the guard is site scoped and this payload is
// deployment scoped.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/system", requireAuth)
	group.GET("/metrics", h.Metrics)
}

// Metrics returns the latest cached resource snapshot.
func (h *Handler) Metrics(c *gin.Context) {
	role, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	if role != "platform_admin" {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "platform_admin_required"))
		return
	}
	if h.latest == nil {
		_ = c.Error(apperr.Internal(nil))
		return
	}
	snapshot := h.latest()
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, snapshot)
}
