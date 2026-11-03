package messaging

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
}

// Handler exposes conversations and private messages over HTTP.
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

// Routes mounts the messaging endpoints under /api/v1.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/conversations", requireAuth)
	group.GET("", h.List)
	group.POST("", h.Create)
	group.GET("/:conversationID/messages", h.Messages)
	group.POST("/:conversationID/messages", h.Send)
	group.POST("/:conversationID/read", h.MarkRead)
}

type createRequest struct {
	Kind    string   `json:"kind"`
	Members []string `json:"members"`
}

type messageRequest struct {
	Body string `json:"body"`
}

type readRequest struct {
	MessageID string `json:"message_id"`
}

type conversationResponse struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	CreatedBy string   `json:"created_by"`
	Members   []string `json:"members"`
}

type messageResponse struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id"`
	SenderID       string `json:"sender_id"`
	Body           string `json:"body"`
	CreatedAt      string `json:"created_at"`
}

// List returns the caller's conversations.
func (h *Handler) List(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	items, err := h.service.List(c.Request.Context(), actor, limitFrom(c))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]conversationResponse, 0, len(items))
	for _, item := range items {
		members := make([]string, 0, len(item.Members))
		for _, member := range item.Members {
			members = append(members, member.UserID)
		}
		views = append(views, conversationResponse{
			ID: item.ID, Kind: string(item.Kind), CreatedBy: item.CreatedBy, Members: members,
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": views})
}

// Create starts a conversation.
func (h *Handler) Create(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req createRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	kind := ConversationKind(req.Kind)
	if kind == "" {
		kind = KindDirect
	}

	created, err := h.service.StartConversation(c.Request.Context(), actor, kind, req.Members)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	members := make([]string, 0, len(created.Members))
	for _, member := range created.Members {
		members = append(members, member.UserID)
	}
	c.JSON(http.StatusCreated, conversationResponse{
		ID: created.ID, Kind: string(created.Kind), CreatedBy: created.CreatedBy, Members: members,
	})
}

// Messages returns the messages of a conversation.
func (h *Handler) Messages(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	items, err := h.service.Messages(c.Request.Context(), actor, c.Param("conversationID"), limitFrom(c))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]messageResponse, 0, len(items))
	for _, item := range items {
		views = append(views, messageResponse{
			ID:             item.ID,
			ConversationID: item.ConversationID,
			SenderID:       item.SenderID,
			Body:           item.Body,
			CreatedAt:      item.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": views})
}

// Send stores a message.
func (h *Handler) Send(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req messageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	created, err := h.service.Send(c.Request.Context(), actor, NewMessageInput{
		ConversationID: c.Param("conversationID"),
		Body:           req.Body,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusCreated, messageResponse{
		ID:             created.ID,
		ConversationID: created.ConversationID,
		SenderID:       created.SenderID,
		Body:           created.Body,
		CreatedAt:      created.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	})
}

// MarkRead advances the caller's read cursor.
func (h *Handler) MarkRead(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	var req readRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	changed, err := h.service.MarkRead(c.Request.Context(), actor, c.Param("conversationID"), req.MessageID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, gin.H{"advanced": changed})
}

func (h *Handler) unauthenticated(c *gin.Context) {
	_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
}

func limitFrom(c *gin.Context) int {
	limit := 0
	if raw := c.Query("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	return limit
}

// mapError translates messaging failures into the API error model.
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
		return apperr.Validation("invalid conversation")
	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("conversation")
	case errors.Is(err, ErrNotMember):
		return apperr.NotFound("conversation")
	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}