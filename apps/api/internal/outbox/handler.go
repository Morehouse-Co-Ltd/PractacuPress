package outbox

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller's site and user.
type PrincipalFunc func(*gin.Context) (siteID, userID string, ok bool)

// Handler exposes the catch-up endpoint.
type EventsHandler struct {
	replayer  *Replayer
	principal PrincipalFunc
}

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
}

// NewHandler builds a Handler.
func NewEventsHandler(replayer *Replayer, cfg HandlerConfig) *EventsHandler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (string, string, bool) { return "", "", false }
	}
	return &EventsHandler{replayer: replayer, principal: principal}
}

// Routes mounts the event replay endpoint under /api/v1.
func (h *EventsHandler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	r.GET("/events", requireAuth, h.Replay)
}

// Replay returns the events the caller missed after the given event id.
//
// This endpoint is the authoritative recovery path: WebSocket delivery is best effort,
// so after a reconnect the client calls this and trusts only its answer.
func (h *EventsHandler) Replay(c *gin.Context) {
	siteID, userID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	limit := 0
	if raw := c.Query("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	if limit <= 0 || limit > MaxReplayLimit {
		limit = DefaultReplayLimit
	}

	afterID := c.Query("after_id")
	if len(afterID) > 64 {
		_ = c.Error(apperr.New(apperr.CodeInvalidCursor))
		return
	}

	events, err := h.replayer.After(c.Request.Context(), siteID, userID, afterID, limit)
	if err != nil {
		_ = c.Error(apperr.Internal(err))
		return
	}

	items := make([]Envelope, 0, len(events))
	for _, event := range events {
		items = append(items, ToEnvelope(event))
	}

	next := ""
	if len(events) == limit && len(events) > 0 {
		next = events[len(events)-1].EventID
	}

	c.JSON(http.StatusOK, gin.H{
		"items":       items,
		"next_cursor": next,
		"has_more":    next != "",
	})
}

var _ = errors.New
