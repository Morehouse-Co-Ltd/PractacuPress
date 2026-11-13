package notifications

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
}

// Handler exposes the notification inbox over HTTP.
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

// Routes mounts the notification endpoints under /api/v1.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/notifications", requireAuth)
	group.GET("", h.Inbox)
	group.GET("/preferences", h.Preferences)
	group.PUT("/preferences", h.UpdatePreferences)
	group.POST("/read-all", h.MarkAllRead)
	group.POST("/:notificationID/read", h.MarkRead)
}

type notificationResponse struct {
	ID        string            `json:"id"`
	Type      string            `json:"type"`
	ActorID   string            `json:"actor_id,omitempty"`
	SubjectID string            `json:"subject_id,omitempty"`
	Payload   map[string]string `json:"payload"`
	Read      bool              `json:"read"`
	ReadAt    *time.Time        `json:"read_at,omitempty"`
	CreatedAt time.Time         `json:"created_at"`
}

// Inbox lists the caller's notifications.
func (h *Handler) Inbox(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	items, err := h.service.Inbox(c.Request.Context(), actor, 0)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]notificationResponse, 0, len(items))
	unread := 0
	for _, item := range items {
		if !item.IsRead() {
			unread++
		}
		views = append(views, toResponse(item))
	}

	c.JSON(http.StatusOK, gin.H{"items": views, "unread": unread})
}

// MarkRead marks one notification read.
func (h *Handler) MarkRead(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	item, err := h.service.MarkRead(c.Request.Context(), actor, c.Param("notificationID"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toResponse(item))
}

// MarkAllRead clears the unread badge.
func (h *Handler) MarkAllRead(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	updated, err := h.service.MarkAllRead(c.Request.Context(), actor)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, gin.H{"updated": updated})
}

// channelPreferences is the JSON shape of one channel's switches.
type channelPreferences struct {
	Enabled    bool `json:"enabled"`
	Comments   bool `json:"comments"`
	Reactions  bool `json:"reactions"`
	Follows    bool `json:"follows"`
	Moderation bool `json:"moderation"`
}

// preferencesResponse is the settings payload plus the deployment capability.
type preferencesResponse struct {
	InApp           channelPreferences `json:"in_app"`
	Email           channelPreferences `json:"email"`
	EmailConfigured bool               `json:"email_configured"`
}

// Preferences returns the caller's notification settings.
func (h *Handler) Preferences(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	preferences, err := h.service.Preferences(c.Request.Context(), actor)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toPreferencesResponse(preferences, h.service.EmailConfigured()))
}

// UpdatePreferences replaces the caller's notification settings.
func (h *Handler) UpdatePreferences(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var body preferencesResponse
	if err := c.ShouldBindJSON(&body); err != nil {
		_ = c.Error(apperr.Validation("invalid notification preferences"))
		return
	}

	preferences := Preferences{
		InApp: fromChannelPreferences(body.InApp),
		Email: fromChannelPreferences(body.Email),
	}
	updated, err := h.service.UpdatePreferences(c.Request.Context(), actor, preferences)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toPreferencesResponse(updated, h.service.EmailConfigured()))
}

func fromChannelPreferences(in channelPreferences) ChannelPreferences {
	return ChannelPreferences{
		Enabled:    in.Enabled,
		Comments:   in.Comments,
		Reactions:  in.Reactions,
		Follows:    in.Follows,
		Moderation: in.Moderation,
	}
}

func toPreferencesResponse(preferences Preferences, emailConfigured bool) preferencesResponse {
	channel := func(in ChannelPreferences) channelPreferences {
		return channelPreferences{
			Enabled:    in.Enabled,
			Comments:   in.Comments,
			Reactions:  in.Reactions,
			Follows:    in.Follows,
			Moderation: in.Moderation,
		}
	}
	return preferencesResponse{
		InApp:           channel(preferences.InApp),
		Email:           channel(preferences.Email),
		EmailConfigured: emailConfigured,
	}
}

func (h *Handler) unauthenticated(c *gin.Context) {
	_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
}

func toResponse(item Notification) notificationResponse {
	return notificationResponse{
		ID:        item.ID,
		Type:      string(item.Type),
		ActorID:   item.ActorID,
		SubjectID: item.SubjectID,
		Payload:   item.Payload,
		Read:      item.IsRead(),
		ReadAt:    item.ReadAt,
		CreatedAt: item.CreatedAt,
	}
}

// mapError translates notification failures into the API error model.
func mapError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation("invalid notification")
	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("notification")
	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()
	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")
	case errors.Is(err, ErrSelfNotification):
		return apperr.Validation("cannot notify yourself")
	case errors.Is(err, ErrPreferencesUnavailable):
		return apperr.Internal(err)
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}
