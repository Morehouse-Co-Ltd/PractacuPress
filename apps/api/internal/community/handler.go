package community

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/captcha"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/safety"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// SiteFunc returns the site resolved for the request.
type SiteFunc func(*gin.Context) (site.Site, bool)

// CaptchaGuard enforces the site's human verification policy.
//
// The interface keeps this package unaware of providers and HTTP clients; the
// composition root wires a captcha.Guard. Nil means "no challenge".
type CaptchaGuard interface {
	Require(ctx context.Context, in captcha.RequireInput) error
}

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
	// Site exposes the resolved site so public comment threads can be read anonymously.
	Site SiteFunc
	// Captcha protects comment writes when the site enables it. Comments are the
	// highest-volume text surface, so they are the cheapest place to put a challenge.
	Captcha CaptchaGuard
	// RequestID returns the correlation id recorded in the captcha audit row.
	RequestID func(*gin.Context) string
}

// Handler exposes comments and interactions over HTTP.
type Handler struct {
	service   *Service
	principal PrincipalFunc
	site      SiteFunc
	captcha   CaptchaGuard
	requestID func(*gin.Context) string
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
	requestID := cfg.RequestID
	if requestID == nil {
		requestID = func(c *gin.Context) string { return c.GetHeader("X-Request-ID") }
	}
	return &Handler{
		service:   service,
		principal: principal,
		site:      siteOf,
		captcha:   cfg.Captcha,
		requestID: requestID,
	}
}

// Routes mounts the community endpoints under /api/v1.
//
// Reading a thread is open to anonymous visitors on a public site; every write still
// requires a session.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc, optionalAuth gin.HandlerFunc) {
	r.GET("/comments", optionalAuth, h.ListComments)
	// The state read is optional auth on purpose: an anonymous reader gets the
	// all-false state instead of a 401, which is exactly what the public content
	// page needs to render its untouched buttons.
	r.GET("/interactions/state", optionalAuth, h.InteractionState)
	r.GET("/interactions/states", optionalAuth, h.InteractionStates)

	group := r.Group("", requireAuth)
	group.POST("/comments", h.CreateComment)
	group.PATCH("/comments/:commentID", h.EditComment)
	group.DELETE("/comments/:commentID", h.DeleteComment)
	group.POST("/comments/:commentID/approve", h.ApproveComment)
	group.POST("/comments/:commentID/reject", h.RejectComment)
	group.POST("/reactions/:targetType/:targetID", h.ToggleReaction)
	group.POST("/bookmarks/:targetType/:targetID", h.ToggleBookmark)
	group.POST("/follows/:userID", h.ToggleFollow)

	// Personal lists. The user is always the authenticated caller; the query string
	// can narrow the list but never choose whose list is read.
	group.GET("/me/bookmarks", h.ListBookmarks)
	group.GET("/me/likes", h.ListLikes)
	group.GET("/me/reading-history", h.ListReadingHistory)
	group.POST("/me/reading-history", h.RecordReading)
	group.GET("/me/following", h.ListFollowing)
	group.GET("/me/followers", h.ListFollowers)
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
	// CaptchaToken is the solved human challenge. Optional in the contract because
	// the site may not require it; refused when missing and the site does.
	CaptchaToken string `json:"captcha_token"`
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
	// RiskScore and RiskFlags are moderator only and stay nil for every other caller,
	// so the public thread cannot receive them at all rather than receiving a zero.
	RiskScore *int     `json:"risk_score,omitempty"`
	RiskFlags []string `json:"risk_flags,omitempty"`
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
	// A moderator reading the queue needs the score to triage; a reader of the thread
	// must not see it, so one projection is used with the flag off.
	moderator := CanModerate(actor)
	for _, item := range items {
		response = append(response, toCommentResponse(item, moderator))
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

	// The challenge is checked before the comment reaches the service: a refused
	// token must not consume the comment frequency window or run the word filter.
	if !h.requireCaptcha(c, actor, req.CaptchaToken) {
		return
	}

	comment, err := h.service.AddComment(c.Request.Context(), actor, NewCommentInput{
		TargetType: TargetType(req.TargetType),
		TargetID:   req.TargetID,
		ParentID:   req.ParentID,
		Body:       req.Body,
	})
	if err != nil {
		h.writeError(c, err)
		return
	}
	c.JSON(http.StatusCreated, toCommentResponse(comment, CanModerate(actor)))
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
		c.JSON(http.StatusOK, toCommentResponse(comment, CanModerate(actor)))
		return
	}

	comment, err := h.service.EditComment(c.Request.Context(), actor, c.Param("commentID"), req.Body)
	if err != nil {
		h.writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, toCommentResponse(comment, CanModerate(actor)))
}

// ApproveComment publishes a comment awaiting review.
func (h *Handler) ApproveComment(c *gin.Context) {
	h.reviewComment(c, true)
}

// RejectComment hides a comment awaiting review.
func (h *Handler) RejectComment(c *gin.Context) {
	h.reviewComment(c, false)
}

func (h *Handler) reviewComment(c *gin.Context, approve bool) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var (
		comment Comment
		err     error
	)
	if approve {
		comment, err = h.service.ApproveComment(c.Request.Context(), actor, c.Param("commentID"))
	} else {
		comment, err = h.service.RejectComment(c.Request.Context(), actor, c.Param("commentID"))
	}
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toCommentResponse(comment, CanModerate(actor)))
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

type interactionStateResponse struct {
	Liked      bool `json:"liked"`
	Bookmarked bool `json:"bookmarked"`
	Following  bool `json:"following"`
}

type interactionStateItemResponse struct {
	TargetID   string `json:"target_id"`
	Liked      bool   `json:"liked"`
	Bookmarked bool   `json:"bookmarked"`
}

type followStateItemResponse struct {
	UserID    string `json:"user_id"`
	Following bool   `json:"following"`
}

type interactionStatesResponse struct {
	Items   []interactionStateItemResponse `json:"items"`
	Follows []followStateItemResponse      `json:"follows"`
}

type interactionEntryResponse struct {
	TargetType  string     `json:"target_type"`
	TargetID    string     `json:"target_id"`
	CreatedAt   time.Time  `json:"created_at"`
	Title       string     `json:"title,omitempty"`
	Summary     string     `json:"summary,omitempty"`
	Kind        string     `json:"kind,omitempty"`
	AuthorID    string     `json:"author_id,omitempty"`
	AuthorName  string     `json:"author_name,omitempty"`
	PublishedAt *time.Time `json:"published_at,omitempty"`
	Available   bool       `json:"available"`
}

type interactionListResponse struct {
	Items      []interactionEntryResponse `json:"items"`
	NextCursor string                     `json:"next_cursor"`
	HasMore    bool                       `json:"has_more"`
}

type readingEntryResponse struct {
	TargetType   string     `json:"target_type"`
	TargetID     string     `json:"target_id"`
	LastViewedAt time.Time  `json:"last_viewed_at"`
	ViewCount    int        `json:"view_count"`
	Title        string     `json:"title,omitempty"`
	Summary      string     `json:"summary,omitempty"`
	Kind         string     `json:"kind,omitempty"`
	AuthorID     string     `json:"author_id,omitempty"`
	AuthorName   string     `json:"author_name,omitempty"`
	PublishedAt  *time.Time `json:"published_at,omitempty"`
	Available    bool       `json:"available"`
}

type readingListResponse struct {
	Items      []readingEntryResponse `json:"items"`
	NextCursor string                 `json:"next_cursor"`
	HasMore    bool                   `json:"has_more"`
}

type followEntryResponse struct {
	UserID        string    `json:"user_id"`
	DisplayName   string    `json:"display_name"`
	Bio           string    `json:"bio,omitempty"`
	AvatarMediaID string    `json:"avatar_media_id,omitempty"`
	Since         time.Time `json:"since"`
}

type followListResponse struct {
	Items      []followEntryResponse `json:"items"`
	NextCursor string                `json:"next_cursor"`
	HasMore    bool                  `json:"has_more"`
}

type readingRequest struct {
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
}

// InteractionState returns the caller's relation to one target.
func (h *Handler) InteractionState(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	state, err := h.service.State(
		c.Request.Context(),
		actor,
		TargetType(c.Query("target_type")),
		c.Query("target_id"),
		c.Query("author_id"),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, interactionStateResponse{
		Liked:      state.Liked,
		Bookmarked: state.Bookmarked,
		Following:  state.Following,
	})
}

// InteractionStates returns the caller's state for a batch of targets.
func (h *Handler) InteractionStates(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	items, follows, err := h.service.States(
		c.Request.Context(),
		actor,
		TargetType(c.Query("target_type")),
		splitCSV(c.Query("target_ids")),
		splitCSV(c.Query("author_ids")),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]interactionStateItemResponse, 0, len(items))
	for _, item := range items {
		views = append(views, interactionStateItemResponse{
			TargetID:   item.TargetID,
			Liked:      item.Liked,
			Bookmarked: item.Bookmarked,
		})
	}
	followViews := make([]followStateItemResponse, 0, len(follows))
	for _, item := range follows {
		followViews = append(followViews, followStateItemResponse{
			UserID:    item.UserID,
			Following: item.Following,
		})
	}
	c.JSON(http.StatusOK, interactionStatesResponse{Items: views, Follows: followViews})
}

// ListBookmarks returns the caller's saved content.
func (h *Handler) ListBookmarks(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	cursor, limit, err := listQuery(c)
	if err != nil {
		_ = c.Error(apperr.Validation("invalid cursor"))
		return
	}

	entries, next, err := h.service.Bookmarks(c.Request.Context(), actor, InteractionListFilter{
		TargetType: TargetType(c.Query("target_type")),
		Limit:      limit,
		After:      cursor,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toInteractionListResponse(entries, next))
}

// ListLikes returns the content the caller liked.
func (h *Handler) ListLikes(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	cursor, limit, err := listQuery(c)
	if err != nil {
		_ = c.Error(apperr.Validation("invalid cursor"))
		return
	}

	kind := c.Query("kind")
	if kind == "" {
		kind = "like"
	}
	entries, next, err := h.service.Likes(c.Request.Context(), actor, InteractionListFilter{
		TargetType: TargetType(c.Query("target_type")),
		Kind:       kind,
		Limit:      limit,
		After:      cursor,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toInteractionListResponse(entries, next))
}

// ListReadingHistory returns the caller's recently read content.
func (h *Handler) ListReadingHistory(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	cursor, limit, err := listQuery(c)
	if err != nil {
		_ = c.Error(apperr.Validation("invalid cursor"))
		return
	}

	entries, next, err := h.service.ReadingHistory(c.Request.Context(), actor, InteractionListFilter{
		TargetType: TargetType(c.Query("target_type")),
		Limit:      limit,
		After:      cursor,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]readingEntryResponse, 0, len(entries))
	for _, item := range entries {
		views = append(views, readingEntryResponse{
			TargetType:   string(item.TargetType),
			TargetID:     item.TargetID,
			LastViewedAt: item.LastViewedAt,
			ViewCount:    item.ViewCount,
			Title:        item.Title,
			Summary:      item.Summary,
			Kind:         item.Kind,
			AuthorID:     item.AuthorID,
			AuthorName:   item.AuthorName,
			PublishedAt:  item.PublishedAt,
			Available:    item.Available,
		})
	}
	c.JSON(http.StatusOK, readingListResponse{Items: views, NextCursor: next, HasMore: next != ""})
}

// RecordReading stores one visit of the caller.
func (h *Handler) RecordReading(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req readingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	if err := h.service.RecordReading(
		c.Request.Context(), actor, TargetType(req.TargetType), req.TargetID,
	); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Status(http.StatusNoContent)
}

// ListFollowing returns the members the caller follows.
func (h *Handler) ListFollowing(c *gin.Context) {
	h.listFollows(c, false)
}

// ListFollowers returns the members who follow the caller.
func (h *Handler) ListFollowers(c *gin.Context) {
	h.listFollows(c, true)
}

func (h *Handler) listFollows(c *gin.Context, followers bool) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	cursor, limit, err := listQuery(c)
	if err != nil {
		_ = c.Error(apperr.Validation("invalid cursor"))
		return
	}

	filter := FollowListFilter{Limit: limit, After: cursor}
	var (
		entries []FollowEntry
		next    string
	)
	if followers {
		entries, next, err = h.service.Followers(c.Request.Context(), actor, filter)
	} else {
		entries, next, err = h.service.Following(c.Request.Context(), actor, filter)
	}
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]followEntryResponse, 0, len(entries))
	for _, item := range entries {
		views = append(views, followEntryResponse{
			UserID:        item.UserID,
			DisplayName:   item.DisplayName,
			Bio:           item.Bio,
			AvatarMediaID: item.AvatarMediaID,
			Since:         item.Since,
		})
	}
	c.JSON(http.StatusOK, followListResponse{Items: views, NextCursor: next, HasMore: next != ""})
}

func toInteractionListResponse(entries []InteractionEntry, next string) interactionListResponse {
	views := make([]interactionEntryResponse, 0, len(entries))
	for _, item := range entries {
		views = append(views, interactionEntryResponse{
			TargetType:  string(item.TargetType),
			TargetID:    item.TargetID,
			CreatedAt:   item.CreatedAt,
			Title:       item.Title,
			Summary:     item.Summary,
			Kind:        item.Kind,
			AuthorID:    item.AuthorID,
			AuthorName:  item.AuthorName,
			PublishedAt: item.PublishedAt,
			Available:   item.Available,
		})
	}
	return interactionListResponse{Items: views, NextCursor: next, HasMore: next != ""}
}

// listQuery decodes the cursor and page size shared by the personal lists.
func listQuery(c *gin.Context) (page.Cursor, int, error) {
	cursor, err := page.Decode(c.Query("cursor"))
	if err != nil {
		return page.Cursor{}, 0, err
	}
	limit, _ := strconv.Atoi(c.Query("limit"))
	return cursor, limit, nil
}

// splitCSV splits a comma separated query parameter, dropping empty entries.
func splitCSV(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func (h *Handler) unauthenticated(c *gin.Context) {
	_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
}

// requireCaptcha enforces the site's human verification policy for a comment.
//
// It returns true when the write may continue; otherwise the problem is already
// attached to the context. The site id comes from the actor (which falls back to
// the resolved site for anonymous readers) so the policy lookup cannot disagree
// with the tenant the comment is about to be written to.
func (h *Handler) requireCaptcha(c *gin.Context, actor Actor, token string) bool {
	if h.captcha == nil {
		return true
	}
	err := h.captcha.Require(c.Request.Context(), captcha.RequireInput{
		SiteID:    actor.SiteID,
		Scene:     captcha.SceneComment,
		Token:     token,
		RemoteIP:  c.ClientIP(),
		ActorID:   actor.UserID,
		RequestID: h.requestID(c),
	})
	if err == nil {
		return true
	}
	_ = c.Error(captcha.Problem(err))
	return false
}

// writeError translates a service failure and attaches Retry-After when the comment
// frequency window tripped.
func (h *Handler) writeError(c *gin.Context, err error) {
	if seconds, ok := RetryAfter(err); ok {
		c.Header("Retry-After", strconv.Itoa(seconds))
	}
	_ = c.Error(mapError(err))
}

// toCommentResponse projects a comment for the wire.
//
// includeRisk is true only for a caller with moderation rights. The score is a work
// aid for the review queue, not reader information: publishing it would tell a spammer
// which signal fired (and therefore what to dodge), and it means nothing to somebody
// reading the thread.
func toCommentResponse(comment Comment, includeRisk bool) commentResponse {
	view := commentResponse{
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
	if includeRisk {
		score := comment.RiskScore
		view.RiskScore = &score
		view.RiskFlags = comment.RiskFlags
	}
	return view
}

// mapError translates community failures into the API error model.
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
		return apperr.Validation("invalid interaction")
	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("comment")
	case errors.Is(err, ErrTargetNotFound):
		// A target that is missing or not visible to the caller is reported the same
		// way, so interactions cannot probe unpublished content ids.
		return apperr.NotFound("interaction target")
	case errors.Is(err, ErrCommentsClosed):
		return apperr.PermissionDenied().WithDetail("reason", "comments_closed")
	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")
	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()
	case errors.Is(err, ErrDepthExceeded):
		return apperr.ValidationField("reply depth exceeded", "depth", "out_of_range")
	case errors.Is(err, ErrSelfTarget):
		return apperr.ValidationField("cannot target yourself", "target", "unsupported")
	case errors.Is(err, safety.ErrRateLimited):
		// The problem body carries the same wait time the Retry-After header does, so
		// a client that only parses JSON can still back off correctly.
		seconds, _ := RetryAfter(err)
		problem := apperr.RateLimited().
			WithDetail("reason", "comment_rate_limited").
			WithDetail("retry_after_seconds", seconds)
		var rateErr *safety.RateLimitError
		if errors.As(err, &rateErr) {
			problem.WithDetail("scope", rateErr.Scope)
		}
		return problem
	case errors.Is(err, safety.ErrRejected):
		// The matched words stay server side; the response only names the policy.
		return apperr.PermissionDenied().WithDetail("reason", "sensitive_word")
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}
