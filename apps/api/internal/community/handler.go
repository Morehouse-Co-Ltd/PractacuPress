package community

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
}

// Handler exposes comments and interactions over HTTP.
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

// Routes mounts the community endpoints under /api/v1.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("", requireAuth)
	group.POST("/comments", h.CreateComment)
	group.PATCH("/comments/:commentID", h.EditComment)
	group.DELETE("/comments/:commentID", h.DeleteComment)
	group.POST("/reactions/:targetType/:targetID", h.ToggleReaction)
	group.POST("/bookmarks/:targetType/:targetID", h.ToggleBookmark)
	group.POST("/follows/:userID", h.ToggleFollow)
}

type commentRequest struct {
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	ParentID   string `json:"parent_id"`
	Body       string `json:"body"`
}

type bodyRequest struct {
	Body string `json:"body"`
}

type toggleRequest struct {
	// Active is optional: omitted means flip the current state.
	Active *bool `json:"active"`
}

type commentResponse struct {
	ID         string `json:"id"`
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	ParentID   string `json:"parent_id,omitempty"`
	Depth      int    `json:"depth"`
	Body       string `json:"body"`
	Status     string `json:"status"`
}

// CreateComment stores a comment or reply.
func (h *Handler) CreateComment(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req commentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	comment, err := h.service.AddComment(c.Request.Context(), actor, NewCommentInput{
		TargetType: TargetType(req.TargetType),
		TargetID:   req.TargetID,
		ParentID:   req.ParentID,
		Body:       req.Body,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusCreated, toCommentResponse(comment))
}

// EditComment changes the body of a comment the caller wrote.
func (h *Handler) EditComment(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req bodyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	comment, err := h.service.EditComment(c.Request.Context(), actor, c.Param("commentID"), req.Body)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toCommentResponse(comment))
}

// DeleteComment soft deletes a comment.
func (h *Handler) DeleteComment(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	if _, err := h.service.DeleteComment(c.Request.Context(), actor, c.Param("commentID")); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Status(http.StatusNoContent)
}

// ToggleReaction adds or removes a reaction.
func (h *Handler) ToggleReaction(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req toggleRequest
	_ = c.ShouldBindJSON(&req)
	kind := c.Query("kind")
	if kind == "" {
		kind = "like"
	}

	active, err := h.service.ToggleReaction(
		c.Request.Context(), actor,
		TargetType(c.Param("targetType")), c.Param("targetID"), kind, req.Active,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, gin.H{"active": active})
}

// ToggleBookmark adds or removes a bookmark.
func (h *Handler) ToggleBookmark(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req toggleRequest
	_ = c.ShouldBindJSON(&req)

	active, err := h.service.ToggleBookmark(
		c.Request.Context(), actor,
		TargetType(c.Param("targetType")), c.Param("targetID"), req.Active,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, gin.H{"active": active})
}

// ToggleFollow follows or unfollows a user.
func (h *Handler) ToggleFollow(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req toggleRequest
	_ = c.ShouldBindJSON(&req)

	active, err := h.service.ToggleFollow(c.Request.Context(), actor, c.Param("userID"), req.Active)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, gin.H{"active": active})
}

func (h *Handler) unauthenticated(c *gin.Context) {
	_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
}

func toCommentResponse(comment Comment) commentResponse {
	return commentResponse{
		ID:         comment.ID,
		TargetType: string(comment.TargetType),
		TargetID:   comment.TargetID,
		ParentID:   comment.ParentID,
		Depth:      comment.Depth,
		Body:       comment.Body,
		Status:     comment.Status,
	}
}

// mapError translates community failures into the API error model.
func mapError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation("invalid interaction")
	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("comment")
	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")
	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()
	case errors.Is(err, ErrDepthExceeded):
		return apperr.Validation("reply depth exceeded")
	case errors.Is(err, ErrSelfTarget):
		return apperr.Validation("cannot target yourself")
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}
