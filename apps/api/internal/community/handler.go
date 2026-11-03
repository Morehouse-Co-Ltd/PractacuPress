package community

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// SiteFunc returns the site resolved for the request.
type SiteFunc func(*gin.Context) (site.Site, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
	// Site exposes the resolved site so public comment threads can be read anonymously.
	Site SiteFunc
}

// Handler exposes comments and interactions over HTTP.
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

// Routes mounts the community endpoints under /api/v1.
//
// Reading a thread is open to anonymous visitors on a public site; every write still
// requires a session.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc, optionalAuth gin.HandlerFunc) {
	r.GET("/comments", optionalAuth, h.ListComments)

	group := r.Group("", requireAuth)
	group.POST("/comments", h.CreateComment)
	group.PATCH("/comments/:commentID", h.EditComment)
	group.DELETE("/comments/:commentID", h.DeleteComment)
	group.POST("/reactions/:targetType/:targetID", h.ToggleReaction)
	group.POST("/bookmarks/:targetType/:targetID", h.ToggleBookmark)
	group.POST("/follows/:userID", h.ToggleFollow)
}

// actor resolves the caller, falling back to an anonymous reader on a public site.
func (h *Handler) actor(c *gin.Context) (Actor, bool) {
	if principal, ok := h.principal(c); ok {
		return principal, true
	}
	resolved, ok := h.site(c)
	if !ok || resolved.IsMembersOnly() {
		return Actor{}, false
	}
	return Actor{SiteID: resolved.ID}, true
}

type commentListResponse struct {
	Items      []commentResponse `json:"items"`
	NextCursor string            `json:"next_cursor"`
	HasMore    bool              `json:"has_more"`
}

type commentRequest struct {
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	ParentID   string `json:"parent_id"`
	Body       string `json:"body"`
}

type bodyRequest struct {
	Body string `json:"body"`
	// Status is a moderator only field: visible restores a comment, hidden removes it
	// from public view without deleting the row.
	Status string `json:"status"`
}

type toggleRequest struct {
	// Active is optional: omitted means flip the current state.
	Active *bool `json:"active"`
}

type commentResponse struct {
	ID         string    `json:"id"`
	TargetType string    `json:"target_type"`
	TargetID   string    `json:"target_id"`
	ParentID   string    `json:"parent_id,omitempty"`
	Depth      int       `json:"depth"`
	Body       string    `json:"body"`
	Status     string    `json:"status"`
	AuthorID   string    `json:"author_id,omitempty"`
	AuthorName string    `json:"author_name,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// ListComments returns a page of comments for a target or for the moderation queue.
func (h *Handler) ListComments(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	cursor, err := page.Decode(c.Query("cursor"))
	if err != nil {
		_ = c.Error(apperr.Validation("invalid cursor"))
		return
	}
	limit, _ := strconv.Atoi(c.Query("limit"))

	filter := CommentListFilter{
		TargetType: TargetType(c.Query("target_type")),
		TargetID:   c.Query("target_id"),
		Query:      c.Query("q"),
		Limit:      limit,
		After:      cursor,
	}
	switch status := c.Query("status"); status {
	case "", "all":
		// The service decides the default: visible for readers, every state for
		// moderators.
	default:
		filter.Statuses = []string{status}
	}

	items, next, err := h.service.ListComments(c.Request.Context(), actor, filter)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	response := make([]commentResponse, 0, len(items))
	for _, item := range items {
		response = append(response, toCommentResponse(item))
	}
	c.JSON(http.StatusOK, commentListResponse{
		Items:      response,
		NextCursor: next,
		HasMore:    next != "",
	})
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

// EditComment changes the body of a comment the caller wrote, or its visibility when
// the caller is a moderator.
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

	if req.Status != "" {
		comment, err := h.service.ModerateComment(c.Request.Context(), actor, c.Param("commentID"), req.Status)
		if err != nil {
			_ = c.Error(mapError(err))
			return
		}
		c.JSON(http.StatusOK, toCommentResponse(comment))
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
		AuthorID:   comment.AuthorID,
		AuthorName: comment.AuthorName,
		CreatedAt:  comment.CreatedAt,
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
	case errors.Is(err, ErrTargetNotFound):
		// A target that is missing or not visible to the caller is reported the same
		// way, so interactions cannot probe unpublished content ids.
		return apperr.NotFound("interaction target")
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
