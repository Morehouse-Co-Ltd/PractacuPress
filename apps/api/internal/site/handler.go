package site

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// UserIDFunc returns the authenticated caller's id.
//
// It is injected so this package does not depend on the HTTP middleware package.
type UserIDFunc func(*gin.Context) (string, bool)

// RequestIDFunc returns the request correlation id.
type RequestIDFunc func(*gin.Context) string

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	UserID    UserIDFunc
	RequestID RequestIDFunc
}

// Handler exposes site administration over HTTP.
type Handler struct {
	service   *Service
	userID    UserIDFunc
	requestID RequestIDFunc
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	userID := cfg.UserID
	if userID == nil {
		userID = func(*gin.Context) (string, bool) { return "", false }
	}
	requestID := cfg.RequestID
	if requestID == nil {
		requestID = func(*gin.Context) string { return "" }
	}
	return &Handler{service: service, userID: userID, requestID: requestID}
}

// Routes mounts the site endpoints under /api/v1.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/sites", requireAuth)
	group.GET("/:siteID", h.GetSite)
	group.GET("/:siteID/members", h.ListMembers)
	group.PATCH("/:siteID/members/:userID/role", h.ChangeMemberRole)
	group.PATCH("/:siteID/settings", h.UpdateSettings)
}

type memberResponse struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	Status      string `json:"status"`
}

type siteResponse struct {
	ID             string `json:"id"`
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	Domain         string `json:"domain"`
	VisibilityMode string `json:"visibility_mode"`
	PublishMode    string `json:"publish_mode"`
	Disabled       bool   `json:"disabled"`
}

type changeRoleRequest struct {
	Role string `json:"role"`
}

type settingsRequest struct {
	Name           string `json:"name"`
	Description    string `json:"description"`
	VisibilityMode string `json:"visibility_mode"`
	PublishMode    string `json:"publish_mode"`
	Domain         string `json:"domain"`
}

// GetSite returns the site to one of its members.
func (h *Handler) GetSite(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	found, err := h.service.Get(c.Request.Context(), actor.SiteID, actor.UserID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusOK, siteResponse{
		ID:             found.ID,
		Slug:           found.Slug,
		Name:           found.Name,
		Domain:         found.Domain,
		VisibilityMode: string(found.VisibilityMode),
		PublishMode:    string(found.PublishMode),
		Disabled:       found.Disabled,
	})
}

// ListMembers returns the members of a site to a manager.
func (h *Handler) ListMembers(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	members, err := h.service.ListMembers(c.Request.Context(), actor, actor.SiteID, 100)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	items := make([]memberResponse, 0, len(members))
	for _, member := range members {
		items = append(items, memberResponse{
			UserID:      member.UserID,
			DisplayName: member.DisplayName,
			Role:        string(member.Role),
			Status:      member.Status,
		})
	}

	c.JSON(http.StatusOK, gin.H{"items": items})
}

// ChangeMemberRole changes another member's role.
func (h *Handler) ChangeMemberRole(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req changeRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	err := h.service.ChangeMemberRole(
		c.Request.Context(),
		actor,
		actor.SiteID,
		c.Param("userID"),
		Role(req.Role),
		h.requestID(c),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.Status(http.StatusNoContent)
}

// UpdateSettings changes site level configuration.
func (h *Handler) UpdateSettings(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req settingsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	err := h.service.UpdateSettings(c.Request.Context(), actor, actor.SiteID, SettingsInput{
		Name:           req.Name,
		Description:    req.Description,
		VisibilityMode: VisibilityMode(req.VisibilityMode),
		PublishMode:    PublishMode(req.PublishMode),
		Domain:         req.Domain,
	}, h.requestID(c))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.Status(http.StatusNoContent)
}

// actor loads the caller's membership of the site in the path.
//
// The path site and the token site must agree: a site administrator of site A must
// not reach site B by editing the URL.
func (h *Handler) actor(c *gin.Context, siteID string) (Member, bool) {
	userID, ok := h.userID(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return Member{}, false
	}

	member, err := h.service.Membership(c.Request.Context(), siteID, userID)
	if err != nil {
		_ = c.Error(mapError(err))
		return Member{}, false
	}
	return member, true
}

// mapError translates site failures into the API error model.
func mapError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil

	case errors.Is(err, ErrMemberNotFound):
		return apperr.PermissionDenied().WithDetail("reason", "not_a_member")

	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")

	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()

	case errors.Is(err, ErrInvalidRole):
		return apperr.Validation("unknown role")

	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation(cleanValidation(err))

	case errors.Is(err, ErrDomainUnverified):
		return apperr.New(apperr.CodeSiteDomainUnverified)

	case errors.Is(err, ErrDisabled), errors.Is(err, ErrNotFound):
		return apperr.NotFound("site")
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}

// cleanValidation keeps validator wording short and free of internal type names.
func cleanValidation(err error) string {
	message := err.Error()
	if len(message) > 200 {
		return "invalid input"
	}
	return message
}
