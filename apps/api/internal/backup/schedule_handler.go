package backup

import (
	"net/http"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// ScheduleHandlerConfig configures a ScheduleHandler.
type ScheduleHandlerConfig struct {
	// Principal resolves the caller. Nil reads the transport principal, which is
	// what a normal server mount needs.
	Principal PrincipalFunc
}

// ScheduleHandler serves the read only view of the automatic backup schedule.
//
// The schedule comes from the environment, so there is nothing to write: the
// endpoint exists so the dashboard can show the values the process really runs
// with instead of the ones an operator believes they configured.
type ScheduleHandler struct {
	scheduler *Scheduler
	principal PrincipalFunc
}

// NewScheduleHandler builds a ScheduleHandler.
func NewScheduleHandler(scheduler *Scheduler, cfg ScheduleHandlerConfig) *ScheduleHandler {
	principal := cfg.Principal
	if principal == nil {
		principal = principalFromMiddleware
	}
	return &ScheduleHandler{scheduler: scheduler, principal: principal}
}

// principalFromMiddleware adapts the transport principal to the backup Actor.
func principalFromMiddleware(c *gin.Context) (Actor, bool) {
	principal, ok := middleware.PrincipalFrom(c)
	if !ok {
		return Actor{}, false
	}
	return Actor{UserID: principal.UserID, SiteID: principal.SiteID, Role: principal.Role}, true
}

// Routes mounts the schedule endpoint under /api/v1.
func (h *ScheduleHandler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/system", requireAuth)
	group.GET("/backup-schedule", h.Get)
}

// Get reports the schedule the process is running with and the artifacts it has
// produced. It is deployment data, so it is platform administrator only.
func (h *ScheduleHandler) Get(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	if err := requirePlatformAdmin(actor); err != nil {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "platform_admin_required"))
		return
	}
	if h.scheduler == nil {
		_ = c.Error(apperr.Internal(nil).WithDetail("reason", "backup_scheduler_unavailable"))
		return
	}
	status := h.scheduler.Status(c.Request.Context())
	if status.Artifacts == nil {
		status.Artifacts = []ScheduleArtifact{}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, status)
}
