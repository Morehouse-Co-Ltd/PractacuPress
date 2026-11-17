package system

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller's role. The system endpoint is a
// deployment-level surface, so the role is the only thing the handler needs.
type PrincipalFunc func(*gin.Context) (role string, ok bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	// Principal resolves the caller. Nil rejects every request.
	Principal PrincipalFunc
	// Deployment returns the process configuration this binary loaded at startup.
	//
	// It is the source of the effective-configuration endpoint. Nil leaves that
	// endpoint failing closed with 500 while the resource panel keeps working, which
	// is the right trade for a composition root that was not updated.
	Deployment func() config.Config
}

// Handler serves the resource snapshot of this installation.
type Handler struct {
	latest     func() Snapshot
	deployment func() config.Config
	principal  PrincipalFunc
}

// NewHandler builds a Handler over a snapshot source.
//
// A nil source means the deployment turned the resource panel off: the metrics route is
// then not registered at all (see Routes) instead of answering a promise it cannot keep.
// The deployment configuration endpoint does not need the sampler, so a Handler built
// with a nil source still serves it.
func NewHandler(latest func() Snapshot, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (string, bool) { return "", false }
	}
	return &Handler{latest: latest, deployment: cfg.Deployment, principal: principal}
}

// Routes mounts the system endpoints under /api/v1.
//
// The route sits behind the normal authentication guard; the platform administrator
// check happens in the handler because the guard is site scoped and this payload is
// deployment scoped.
//
// The resource panel is optional, the deployment configuration surface is not: a Handler
// without a snapshot source registers no metrics route, which is how the panel module is
// removed without changing the contract.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/system", requireAuth)
	if h.latest != nil {
		group.GET("/metrics", h.Metrics)
	}
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
