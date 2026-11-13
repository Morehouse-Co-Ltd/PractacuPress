package audit

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (site.Member, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	// Principal resolves the caller. Required: the audit trail is never public.
	Principal PrincipalFunc
}

// Handler exposes the audit query over HTTP.
type Handler struct {
	service   *Service
	principal PrincipalFunc
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (site.Member, bool) { return site.Member{}, false }
	}
	return &Handler{service: service, principal: principal}
}

// Routes mounts the audit query under /api/v1.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/sites", requireAuth)
	group.GET("/:siteID/audit-logs", h.List)
}

type logResponse struct {
	ID         string         `json:"id"`
	SiteID     string         `json:"site_id,omitempty"`
	ActorID    string         `json:"actor_id,omitempty"`
	ActorName  string         `json:"actor_name,omitempty"`
	Action     string         `json:"action"`
	TargetType string         `json:"target_type,omitempty"`
	TargetID   string         `json:"target_id,omitempty"`
	TargetName string         `json:"target_name,omitempty"`
	RequestID  string         `json:"request_id,omitempty"`
	Outcome    string         `json:"outcome"`
	Detail     map[string]any `json:"detail,omitempty"`
	CreatedAt  time.Time      `json:"created_at"`
}

type listResponse struct {
	Items      []logResponse `json:"items"`
	NextCursor string        `json:"next_cursor,omitempty"`
}

// List returns one filtered page of a site's audit trail.
func (h *Handler) List(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	filter, limit, after, problem := parseQuery(c)
	if problem != nil {
		_ = c.Error(problem)
		return
	}

	result, err := h.service.List(c.Request.Context(), actor, c.Param("siteID"), filter, limit, after)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	items := make([]logResponse, 0, len(result.Items))
	for _, entry := range result.Items {
		items = append(items, logResponse{
			ID:         entry.ID,
			SiteID:     entry.SiteID,
			ActorID:    entry.ActorID,
			ActorName:  entry.ActorName,
			Action:     entry.Action,
			TargetType: entry.TargetType,
			TargetID:   entry.TargetID,
			TargetName: entry.TargetName,
			RequestID:  entry.RequestID,
			Outcome:    entry.Outcome,
			Detail:     entry.Detail,
			CreatedAt:  entry.CreatedAt.UTC(),
		})
	}

	c.JSON(http.StatusOK, listResponse{Items: items, NextCursor: result.NextCursor})
}

// parseQuery reads and validates the filter parameters.
//
// Time values are RFC 3339 timestamps (fractional seconds accepted). A malformed
// value is a client error rather than a silent "no filter": returning all rows
// for a broken date field would hide the client bug and leak too much data.
func parseQuery(c *gin.Context) (Filter, int, page.Cursor, *apperr.Problem) {
	filter := Filter{
		ActorID:    c.Query("actor_id"),
		Action:     c.Query("action"),
		TargetType: c.Query("target_type"),
		TargetID:   c.Query("target_id"),
		Outcome:    c.Query("outcome"),
	}

	from, problem := parseTimeQuery(c, "from")
	if problem != nil {
		return Filter{}, 0, page.Cursor{}, problem
	}
	to := (*time.Time)(nil)
	to, problem = parseTimeQuery(c, "to")
	if problem != nil {
		return Filter{}, 0, page.Cursor{}, problem
	}
	filter.From = from
	filter.To = to

	limit := 0
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 || parsed > MaxLimit {
			return Filter{}, 0, page.Cursor{}, apperr.Validation("limit must be between 1 and 100").
				WithDetail("field", "limit")
		}
		limit = parsed
	}

	after, err := page.Decode(c.Query("cursor"))
	if err != nil {
		return Filter{}, 0, page.Cursor{}, apperr.New(apperr.CodeInvalidCursor)
	}

	return filter, limit, after, nil
}

func parseTimeQuery(c *gin.Context, name string) (*time.Time, *apperr.Problem) {
	raw := c.Query(name)
	if raw == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return nil, apperr.Validation(name+" must be an RFC 3339 timestamp").
			WithDetail("field", name)
	}
	return &parsed, nil
}

func mapError(err error) *apperr.Problem {
	switch {
	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied().WithDetail("reason", "audit_not_allowed")
	case errors.Is(err, ErrInvalidFilter):
		return apperr.Validation("invalid audit filter")
	default:
		var problem *apperr.Problem
		if errors.As(err, &problem) {
			return problem
		}
		return apperr.Internal(err)
	}
}
