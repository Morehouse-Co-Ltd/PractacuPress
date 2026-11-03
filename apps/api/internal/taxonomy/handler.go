package taxonomy

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// SiteFunc returns the site resolved from the request host.
type SiteFunc func(*gin.Context) (site.Site, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	// Principal resolves the caller of a write request.
	Principal PrincipalFunc
	// Site exposes the resolved site so an anonymous read stays inside one tenant.
	Site SiteFunc
}

// Handler exposes taxonomy terms over HTTP.
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

// Routes mounts the taxonomy endpoints under /api/v1.
//
// Reading is anonymous because public pages render category navigation and tag chips;
// every write is behind the session guard. The handler still scopes an anonymous read
// to the site resolved from the request host, so the path cannot select another tenant.
func (h *Handler) Routes(r gin.IRouter, requireAuth, optionalAuth gin.HandlerFunc) {
	group := r.Group("/sites/:siteID/taxonomy")
	group.GET("", optionalAuth, h.List)
	group.POST("", requireAuth, h.Create)
	group.PATCH("/:termID", requireAuth, h.Update)
	group.DELETE("/:termID", requireAuth, h.Delete)
}

type termResponse struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Description string `json:"description"`
	Color       string `json:"color"`
}

type termListResponse struct {
	Categories []termResponse `json:"categories"`
	Tags       []termResponse `json:"tags"`
}

type createRequest struct {
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Description string `json:"description"`
	Color       string `json:"color"`
}

type patchRequest struct {
	Name        *string `json:"name"`
	Slug        *string `json:"slug"`
	Description *string `json:"description"`
	Color       *string `json:"color"`
}

// List returns the categories and tags of a site.
//
// It is readable without a session on a public site, but never across tenants: the
// path site must be the site the request host resolved to. Without a resolved site the
// read is refused because there is nothing to prove the path belongs to the caller's
// host.
//
// On a members-only site the read requires a session scoped to that site. Category and
// tag names describe content anonymous readers cannot see, so serving them publicly
// would leak the tenant's taxonomy (V-11). The rule mirrors content/handler.go actor():
// a session scoped to this site is enough, the live membership role is not involved.
func (h *Handler) List(c *gin.Context) {
	siteID := c.Param("siteID")

	resolved, ok := h.site(c)
	if !ok {
		_ = c.Error(apperr.New(apperr.CodeSiteNotFound).WithRequestID(c.GetHeader("X-Request-ID")))
		return
	}
	if resolved.ID != siteID {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "cross_site"))
		return
	}
	actor, authenticated := h.principal(c)
	if authenticated && actor.SiteID != siteID {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "cross_site"))
		return
	}
	if resolved.IsMembersOnly() && !authenticated {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "members_only_site"))
		return
	}

	terms, err := h.service.List(c.Request.Context(), siteID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	response := termListResponse{
		Categories: make([]termResponse, 0),
		Tags:       make([]termResponse, 0),
	}
	for _, term := range terms {
		if term.Kind == KindCategory {
			response.Categories = append(response.Categories, toResponse(term))
		}
		if term.Kind == KindTag {
			response.Tags = append(response.Tags, toResponse(term))
		}
	}

	c.JSON(http.StatusOK, response)
}

// Create adds a category or tag.
func (h *Handler) Create(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}

	var req createRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	term, err := h.service.Create(c.Request.Context(), actor, c.Param("siteID"), Input{
		Kind:        Kind(req.Kind),
		Name:        req.Name,
		Slug:        req.Slug,
		Description: req.Description,
		Color:       req.Color,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusCreated, toResponse(term))
}

// Update applies a partial change to one term.
func (h *Handler) Update(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}

	var req patchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	term, err := h.service.Update(
		c.Request.Context(),
		actor,
		c.Param("siteID"),
		c.Param("termID"),
		PatchInput{
			Name:        req.Name,
			Slug:        req.Slug,
			Description: req.Description,
			Color:       req.Color,
		},
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusOK, toResponse(term))
}

// Delete removes one term.
func (h *Handler) Delete(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}

	if err := h.service.Delete(c.Request.Context(), actor, c.Param("siteID"), c.Param("termID")); err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.Status(http.StatusNoContent)
}

// actor resolves the authenticated caller or writes the rejection.
func (h *Handler) actor(c *gin.Context) (Actor, bool) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return Actor{}, false
	}
	return actor, true
}

func toResponse(term Term) termResponse {
	return termResponse{
		ID:          term.ID,
		Kind:        string(term.Kind),
		Name:        term.Name,
		Slug:        term.Slug,
		Description: term.Description,
		Color:       term.Color,
	}
}

// mapError translates taxonomy failures into the API error model.
func mapError(err error) *apperr.Problem {
	var fieldErr *apperr.FieldError

	switch {
	case err == nil:
		return nil

	case errors.As(err, &fieldErr):
		// The input failed a known rule: the client gets the stable field/rule pair and
		// keeps the english reason for operators.
		return apperr.ValidationField(fieldErr.Reason, fieldErr.Field, fieldErr.Rule)

	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation("invalid taxonomy term")

	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("taxonomy term")

	case errors.Is(err, ErrConflict):
		return apperr.Conflict(apperr.CodeConflict).WithMessage("name or slug already exists")

	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")

	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}
