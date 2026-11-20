package storageadmin

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/audit"
	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
)

// Principal is the authenticated caller.
type Principal struct {
	UserID string
	SiteID string
	Role   site.Role
}

// PrincipalFunc resolves the caller. Tests mount the routes with a stub.
type PrincipalFunc func(*gin.Context) (Principal, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
	Audit     audit.Recorder
	Logger    *slog.Logger
}

// Handler serves GET/PUT /api/v1/system/storage.
type Handler struct {
	manager   *Manager
	principal PrincipalFunc
	audit     audit.Recorder
	logger    *slog.Logger
}

// NewHandler builds a Handler. A nil manager still mounts the routes and answers
// 500, which keeps the OpenAPI contract stable for partial routers.
func NewHandler(manager *Manager, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = principalFromTransport
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Handler{manager: manager, principal: principal, audit: cfg.Audit, logger: logger}
}

func principalFromTransport(c *gin.Context) (Principal, bool) {
	principal, ok := middleware.PrincipalFrom(c)
	if !ok {
		return Principal{}, false
	}
	return Principal{UserID: principal.UserID, SiteID: principal.SiteID, Role: principal.Role}, true
}

// Routes mounts the runtime storage endpoints under /api/v1.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/system", requireAuth)
	group.GET("/storage", h.Get)
	group.PUT("/storage", h.Put)
}

// Get returns the redacted runtime storage view.
func (h *Handler) Get(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	if !principal.Role.AtLeast(site.RoleSiteAdmin) {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "administrator_required"))
		return
	}
	if h.manager == nil {
		_ = c.Error(apperr.Internal(nil).WithDetail("reason", "storage_manager_unavailable"))
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, h.manager.Status())
}

// Put applies a new strategy document immediately. Only the platform
// administrator may move deployment-wide data.
func (h *Handler) Put(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	if principal.Role != site.RolePlatformAdmin {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "platform_admin_required"))
		return
	}
	if h.manager == nil {
		_ = c.Error(apperr.Internal(nil).WithDetail("reason", "storage_manager_unavailable"))
		return
	}

	var request UpdateRequest
	if err := json.NewDecoder(c.Request.Body).Decode(&request); err != nil {
		_ = c.Error(apperr.Validation("invalid storage settings").WithDetail("reason", "invalid_json"))
		return
	}

	status, err := h.manager.Apply(c.Request.Context(), request)
	if err != nil {
		_ = c.Error(h.problem(err))
		return
	}

	if h.audit != nil {
		entry := audit.Entry{
			SiteID:     principal.SiteID,
			ActorID:    principal.UserID,
			Action:     "system.storage.updated",
			TargetType: "deployment",
			TargetID:   "storage",
			RequestID:  middleware.RequestIDFrom(c),
			Outcome:    "success",
			Detail: map[string]any{
				"strategies": len(request.Strategies),
				"source":     SourceSaved,
			},
		}
		if auditErr := h.audit.Record(c.Request.Context(), entry); auditErr != nil {
			// The switch already happened; a missing audit row must not roll it back.
			h.logger.Warn("record storage change", "error", auditErr)
		}
	}

	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, status)
}

func (h *Handler) problem(err error) *apperr.Problem {
	var validation *ValidationError
	if errors.As(err, &validation) {
		return apperr.ValidationField(validation.Message, validation.Field, validation.Rule)
	}
	var build *BuildError
	if errors.As(err, &build) {
		return apperr.Validation("storage target is not reachable").
			WithMessage("无法连接存储目标，请检查桶名、端点与密钥").
			WithDetail("reason", "storage_target_unreachable").
			WithCause(err)
	}
	return apperr.Internal(err).WithDetail("reason", "storage_apply_failed")
}
