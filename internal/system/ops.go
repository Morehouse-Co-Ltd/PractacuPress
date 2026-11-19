package system

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/observability"
	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
)

// OpsPrincipal is the authenticated caller of the operations endpoints.
type OpsPrincipal struct {
	UserID string
	SiteID string
	Role   site.Role
}

// OpsPrincipalFunc resolves the caller. It exists so tests can mount the routes
// without a token issuer; production uses the transport principal.
type OpsPrincipalFunc func(*gin.Context) (OpsPrincipal, bool)

// OpsHandlerConfig configures an OpsHandler.
type OpsHandlerConfig struct {
	// Principal is optional: nil reads the transport principal.
	Principal OpsPrincipalFunc
	// Now is the clock used for the queue's oldest age. Nil uses the wall clock.
	Now func() time.Time
}

// OpsHandler serves the operational panels of Beta 1.2 contract K: the request
// log viewer and the async queue monitor with its retry action.
//
// Both are site administrator surfaces. The log ring is per site because every
// entry carries the site it was served for; the queue is per site because both
// backing tables are tenant scoped. A platform administrator sees every site,
// which is the deployment view an operator needs when the process is behind.
type OpsHandler struct {
	logs      *observability.Recorder
	queue     QueueStore
	principal OpsPrincipalFunc
	now       func() time.Time
}

// NewOpsHandler builds an OpsHandler. Either dependency may be nil for a partial
// deployment; the corresponding endpoint then fails closed with 500 instead of
// disappearing, which keeps the contract stable.
func NewOpsHandler(
	logs *observability.Recorder,
	queue QueueStore,
	cfg OpsHandlerConfig,
) *OpsHandler {
	principal := cfg.Principal
	if principal == nil {
		principal = principalFromTransport
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &OpsHandler{logs: logs, queue: queue, principal: principal, now: now}
}

// principalFromTransport reads the caller the authentication guard resolved.
func principalFromTransport(c *gin.Context) (OpsPrincipal, bool) {
	principal, ok := middleware.PrincipalFrom(c)
	if !ok {
		return OpsPrincipal{}, false
	}
	return OpsPrincipal{
		UserID: principal.UserID,
		SiteID: principal.SiteID,
		Role:   principal.Role,
	}, true
}

// Routes mounts the operations endpoints under /api/v1.
func (h *OpsHandler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/system", requireAuth)
	group.GET("/logs", h.Logs)
	group.GET("/queue", h.Queue)
	group.POST("/queue/retry", h.RetryQueue)
}

// Logs returns the newest request metadata of the caller's site.
func (h *OpsHandler) Logs(c *gin.Context) {
	principal, ok := h.requireOperator(c)
	if !ok {
		return
	}
	if h.logs == nil {
		_ = c.Error(apperr.Internal(nil).WithDetail("reason", "request_log_unavailable"))
		return
	}

	// The documented limit parameter caps at 100 even though the ring holds 500
	// entries: the panel pages by scrolling within one short window, not by
	// downloading the whole buffer.
	limit := h.logs.Capacity()
	if limit > MaxLogsLimit {
		limit = MaxLogsLimit
	}
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 || parsed > MaxLogsLimit {
			_ = c.Error(apperr.Validation("limit must be between 1 and 100").
				WithDetail("field", "limit"))
			return
		}
		limit = parsed
	}

	filter := observability.Filter{
		Limit:  limit,
		Method: strings.TrimSpace(c.Query("method")),
		Path:   strings.TrimSpace(c.Query("path")),
	}
	if raw := c.Query("status"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 100 || parsed > 599 {
			_ = c.Error(apperr.Validation("status must be an HTTP status code").
				WithDetail("field", "status"))
			return
		}
		filter.Status = parsed
	}
	// A site administrator only ever sees the site they are signed in to. The
	// platform administrator is the deployment operator and sees every site.
	if principal.Role != site.RolePlatformAdmin {
		filter.SiteID = principal.SiteID
	}

	items := h.logs.List(filter)
	if items == nil {
		items = []observability.Entry{}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// Queue returns the outbox and mail backlog plus a window of recent events.
func (h *OpsHandler) Queue(c *gin.Context) {
	principal, ok := h.requireOperator(c)
	if !ok {
		return
	}
	if h.queue == nil {
		_ = c.Error(apperr.Internal(nil).WithDetail("reason", "queue_unavailable"))
		return
	}
	status, err := h.queue.Status(c.Request.Context(), queueSiteScope(principal), h.now())
	if err != nil {
		_ = c.Error(apperr.Internal(err))
		return
	}
	if status.Recent == nil {
		status.Recent = []QueueEvent{}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, status)
}

// RetryQueue makes failed outbox events deliverable again.
func (h *OpsHandler) RetryQueue(c *gin.Context) {
	principal, ok := h.requireOperator(c)
	if !ok {
		return
	}
	if h.queue == nil {
		_ = c.Error(apperr.Internal(nil).WithDetail("reason", "queue_unavailable"))
		return
	}

	var body struct {
		EventIDs []string `json:"event_ids"`
	}
	// An absent body is valid: it means "the newest failed events".
	if c.Request.ContentLength != 0 {
		if err := c.ShouldBindJSON(&body); err != nil {
			_ = c.Error(apperr.Validation("malformed json body"))
			return
		}
	}
	if len(body.EventIDs) > MaxQueueRetryIDs {
		_ = c.Error(apperr.Validation("at most 100 event ids may be retried at once").
			WithDetail("field", "event_ids"))
		return
	}

	retried, err := h.queue.RetryFailed(
		c.Request.Context(), queueSiteScope(principal), body.EventIDs, QueueRetryDefaultLimit)
	if err != nil {
		if errors.Is(err, ErrTooManyRetryIDs) {
			_ = c.Error(apperr.Validation("at most 100 event ids may be retried at once").
				WithDetail("field", "event_ids"))
			return
		}
		_ = c.Error(apperr.Internal(err))
		return
	}
	c.JSON(http.StatusOK, gin.H{"retried": retried})
}

// requireOperator enforces the site administrator seat and returns the caller.
func (h *OpsHandler) requireOperator(c *gin.Context) (OpsPrincipal, bool) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return OpsPrincipal{}, false
	}
	if !principal.Role.AtLeast(site.RoleSiteAdmin) {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "administrator_required"))
		return OpsPrincipal{}, false
	}
	return principal, true
}

// queueSiteScope maps the caller onto the tenant filter of the queue store.
func queueSiteScope(principal OpsPrincipal) string {
	if principal.Role == site.RolePlatformAdmin {
		return ""
	}
	return principal.SiteID
}

// MaxLogsLimit is the documented ceiling of GET /system/logs?limit=.
const MaxLogsLimit = 100
