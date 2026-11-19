package moderation

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
}

// Handler exposes the report queue over HTTP.
type Handler struct {
	service   *Service
	principal PrincipalFunc
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (Actor, bool) { return Actor{}, false }
	}
	return &Handler{service: service, principal: principal}
}

// Routes mounts the report endpoints under /api/v1.
//
// Filing and reading the queue live under one prefix because both are report
// operations; the service enforces that reading requires a moderator role.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/reports", requireAuth)
	group.POST("", h.File)
	group.GET("", h.Queue)
	group.POST("/:reportID/assign", h.Assign)
	group.POST("/:reportID/resolve", h.Resolve)
}

type reportRequest struct {
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	Reason     string `json:"reason"`
	Note       string `json:"note"`
}

type resolveRequest struct {
	Action string `json:"action"`
	Note   string `json:"note"`
}

type reportResponse struct {
	ID         string    `json:"id"`
	ReporterID string    `json:"reporter_id"`
	TargetType string    `json:"target_type"`
	TargetID   string    `json:"target_id"`
	Reason     string    `json:"reason"`
	Note       string    `json:"note,omitempty"`
	Status     string    `json:"status"`
	AssigneeID string    `json:"assignee_id,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// File records a report against content or an account.
func (h *Handler) File(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req reportRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	report, err := h.service.File(c.Request.Context(), actor, NewReportInput{
		TargetType: TargetType(req.TargetType),
		TargetID:   req.TargetID,
		Reason:     Reason(req.Reason),
		Note:       req.Note,
	}, "")
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusCreated, toResponse(report))
}

// Queue lists the open reports of the caller's site.
func (h *Handler) Queue(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	items, err := h.service.Queue(c.Request.Context(), actor, 0)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]reportResponse, 0, len(items))
	for _, item := range items {
		views = append(views, toResponse(item))
	}
	c.JSON(http.StatusOK, gin.H{"items": views})
}

// Assign claims a report for the caller.
func (h *Handler) Assign(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	report, err := h.service.Assign(c.Request.Context(), actor, c.Param("reportID"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toResponse(report))
}

// Resolve applies an ignore, takedown or ban action and closes the report.
func (h *Handler) Resolve(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req resolveRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	report, err := h.service.ResolveAction(c.Request.Context(), actor, c.Param("reportID"), ResolveInput{
		Action: Action(req.Action),
		Note:   req.Note,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toResponse(report))
}

func (h *Handler) unauthenticated(c *gin.Context) {
	_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
}

func toResponse(report Report) reportResponse {
	return reportResponse{
		ID:         report.ID,
		ReporterID: report.ReporterID,
		TargetType: string(report.TargetType),
		TargetID:   report.TargetID,
		Reason:     string(report.Reason),
		Note:       report.Note,
		Status:     string(report.Status),
		AssigneeID: report.AssigneeID,
		CreatedAt:  report.CreatedAt,
		UpdatedAt:  report.UpdatedAt,
	}
}

// mapError translates moderation failures into the API error model.
func mapError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation("invalid report")
	case errors.Is(err, ErrSelfReport):
		return apperr.ValidationField("cannot report your own content", "target", "unsupported")
	case errors.Is(err, ErrDuplicateReport):
		return apperr.Conflict(apperr.CodeConflict).WithDetail("reason", "duplicate_report")
	case errors.Is(err, ErrRateLimited):
		return apperr.RateLimited()
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrTargetNotFound):
		return apperr.NotFound("report")
	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")
	case errors.Is(err, ErrPermissionDenied), errors.Is(err, ErrNotAssignee), errors.Is(err, ErrActionNotAllowed):
		return apperr.PermissionDenied()
	case errors.Is(err, ErrAlreadyClosed):
		return apperr.Conflict(apperr.CodeConflict).WithDetail("reason", "report_closed")
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}
