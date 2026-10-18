package content

import (
	"errors"
		"context"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

		"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
)

// PrincipalFunc returns the authenticated caller's id, site and role.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// SiteFunc returns the site resolved for the request.
type SiteFunc func(*gin.Context) (site.Site, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
	// Site exposes the resolved site so public reads can be served anonymously.
	Site SiteFunc
}

// Handler exposes content authoring and moderation over HTTP.
type Handler struct {
	service   *Service
	principal PrincipalFunc
	site      SiteFunc
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (Actor, bool) { return Actor{}, false }
	}
	siteOf := cfg.Site
	if siteOf == nil {
		siteOf = func(*gin.Context) (site.Site, bool) { return site.Site{}, false }
	}
	return &Handler{service: service, principal: principal, site: siteOf}
}

// actor resolves the caller, falling back to an anonymous reader on a public site.
//
// A members-only site refuses the request outright, so the difference between the two
// visibility modes lives in exactly one place.
func (h *Handler) actor(c *gin.Context) (Actor, bool) {
	if principal, ok := h.principal(c); ok {
		return principal, true
	}

	resolved, ok := h.site(c)
	if !ok || resolved.IsMembersOnly() {
		return Actor{}, false
	}
	// The zero role carries no authority, so an anonymous reader can only ever see
	// what the service exposes to everyone.
	return Actor{SiteID: resolved.ID}, true
}

// requireActor resolves the caller or writes the rejection.
func (h *Handler) requireActor(c *gin.Context) (Actor, bool) {
	actor, ok := h.actor(c)
	if !ok {
		h.unauthenticated(c)
		return Actor{}, false
	}
	return actor, true
}

// Routes mounts the article and post endpoints under /api/v1.
//
// The two kinds share one handler: the only difference is the path segment, and
// duplicating the surface would guarantee they drift apart.
func (h *Handler) Routes(r gin.IRouter, requireAuth, optionalAuth gin.HandlerFunc) {
	for _, kind := range []Kind{KindArticle, KindPost} {
		base := "/" + string(kind) + "s"
		contentKind := kind

		// Reads are open to anonymous visitors on a public site; the handler decides
		// per request using the resolved site's visibility mode.
		r.GET(base, optionalAuth, func(c *gin.Context) { h.list(c, contentKind) })
		r.GET(base+"/:contentID", optionalAuth, h.get)

		writes := r.Group(base, requireAuth)
		writes.POST("", func(c *gin.Context) { h.create(c, contentKind) })
		writes.PATCH("/:contentID", h.update)
		writes.POST("/:contentID/:action", h.action)
	}
}

type contentResponse struct {
	ID            string     `json:"id"`
	Kind          string     `json:"kind"`
	Status        string     `json:"status"`
	Title         string     `json:"title"`
	Slug          string     `json:"slug"`
	Summary       string     `json:"summary"`
	SourceFormat  string     `json:"source_format"`
	RenderedHTML  string     `json:"rendered_html"`
	PolicyVersion string     `json:"policy_version"`
	PublishedAt   *time.Time `json:"published_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	Actions       []string   `json:"actions"`
}

type draftRequest struct {
	Title        string `json:"title"`
	Slug         string `json:"slug"`
	Summary      string `json:"summary"`
	SourceFormat string `json:"source_format"`
	SourceBody   string `json:"source_body"`
	CategoryID   string `json:"category_id"`
}

type actionRequest struct {
	Reason string `json:"reason"`
}

func (h *Handler) create(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	var req draftRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	item, err := h.service.CreateDraft(c.Request.Context(), actor, kind, toDraftInput(req))
	if err != nil && !errors.Is(err, ErrSecurityUnavailable) {
		_ = c.Error(mapError(err))
		return
	}

	// A security hold still returns the saved item, with 503 so the client retries.
	status := http.StatusCreated
	if errors.Is(err, ErrSecurityUnavailable) {
		status = http.StatusServiceUnavailable
	}
	c.JSON(status, h.view(item, actor))
}

// list returns the items of a site the caller may see.
func (h *Handler) list(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	limit := 0
	if raw := c.Query("limit"); raw != "" {
		if parsed, convErr := strconv.Atoi(raw); convErr == nil {
			limit = parsed
		}
	}

	cursor, err := page.Decode(c.Query("cursor"))
	if err != nil {
		_ = c.Error(apperr.New(apperr.CodeInvalidCursor).WithRequestID(c.GetHeader("X-Request-ID")))
		return
	}

	items, next, err := h.service.ListAfter(c.Request.Context(), actor, kind, limit, cursor)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]contentResponse, 0, len(items))
	for _, item := range items {
		views = append(views, h.view(item, actor))
	}

	c.JSON(http.StatusOK, gin.H{
		"items":       views,
		"next_cursor": next,
		"has_more":    next != "",
	})
}

func (h *Handler) get(c *gin.Context) {	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	item, err := h.service.Get(c.Request.Context(), actor, c.Param("contentID"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, h.view(item, actor))
}

func (h *Handler) update(c *gin.Context) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	var req draftRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	item, err := h.service.UpdateDraft(c.Request.Context(), actor, c.Param("contentID"), toDraftInput(req))
	if err != nil && !errors.Is(err, ErrSecurityUnavailable) {
		_ = c.Error(mapError(err))
		return
	}

	status := http.StatusOK
	if errors.Is(err, ErrSecurityUnavailable) {
		status = http.StatusServiceUnavailable
	}
	c.JSON(status, h.view(item, actor))
}

func (h *Handler) action(c *gin.Context) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	raw := c.Param("action")
	if raw == "security-retry" {
		item, err := h.service.RetrySecurityCheck(c.Request.Context(), actor, c.Param("contentID"))
		if err != nil {
			_ = c.Error(mapError(err))
			return
		}
		c.JSON(http.StatusOK, h.view(item, actor))
		return
	}

	var req actionRequest
	// The body is optional: a publish without a reason is valid.
	_ = c.ShouldBindJSON(&req)

	item, err := h.service.Apply(c.Request.Context(), actor, c.Param("contentID"), Action(raw), req.Reason)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, h.view(item, actor))
}

// view renders an item together with the actions this actor may take on it, so the
// client never has to reimplement the state machine to decide which buttons to show.
func (h *Handler) view(item Content, actor Actor) contentResponse {
	actions := make([]string, 0, 5)
	if available, err := h.service.Actions(context.Background(), actor, item); err == nil {
		for _, action := range available {
			actions = append(actions, string(action))
		}
	}

	return contentResponse{
		ID:            item.ID,
		Kind:          string(item.Kind),
		Status:        string(item.Status),
		Title:         item.Title,
		Slug:          item.Slug,
		Summary:       item.Summary,
		SourceFormat:  string(item.SourceFormat),
		RenderedHTML:  item.RenderedHTML,
		PolicyVersion: item.PolicyVersion,
		PublishedAt:   item.PublishedAt,
		CreatedAt:     item.CreatedAt,
		UpdatedAt:     item.UpdatedAt,
		Actions:       actions,
	}
}

func (h *Handler) unauthenticated(c *gin.Context) {
	_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
}

func toDraftInput(req draftRequest) DraftInput {
	format := SourceFormat(req.SourceFormat)
	if format == "" {
		format = FormatMarkdown
	}
	return DraftInput{
		Title:        req.Title,
		Slug:         req.Slug,
		Summary:      req.Summary,
		SourceFormat: format,
		SourceBody:   req.SourceBody,
		CategoryID:   req.CategoryID,
	}
}

// mapError translates content failures into the API error model.
func mapError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil

	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation("invalid content")

	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("content")

	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")

	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()

	case errors.Is(err, ErrReviewRequired):
		return apperr.Conflict(apperr.CodeContentStateInvalid).
			WithMessage("该站点要求先提交审核")

	case errors.Is(err, ErrInvalidTransition):
		return apperr.New(apperr.CodeContentStateInvalid)

	case errors.Is(err, ErrSecurityUnavailable):
		return apperr.New(apperr.CodeSecurityUnavailable)
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}
