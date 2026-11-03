package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller for ticket issuance.
type PrincipalFunc func(*gin.Context) (siteID, userID string, ok bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
	// OriginPatterns are the allowed browser origins for the upgrade.
	OriginPatterns []string
}

// Handler serves the ticket endpoint and the WebSocket itself.
type Handler struct {
	tickets   *TicketStore
	hub       *Hub
	principal PrincipalFunc
	origins   []string
}

// NewHandler builds a Handler.
func NewHandler(tickets *TicketStore, hub *Hub, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (string, string, bool) { return "", "", false }
	}
	return &Handler{tickets: tickets, hub: hub, principal: principal, origins: cfg.OriginPatterns}
}

// Routes mounts the ticket endpoint and the socket.
//
// The socket itself is not behind the bearer guard: the ticket is the credential, which
// is what lets a browser connect without putting a token in the URL.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	r.POST("/auth/ws-ticket", requireAuth, h.IssueTicket)
	r.GET("/ws", h.Connect)
}

// IssueTicket mints a one time ticket for the caller.
func (h *Handler) IssueTicket(c *gin.Context) {
	siteID, userID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	plain, expires, err := h.tickets.Issue(Ticket{SiteID: siteID, UserID: userID})
	if err != nil {
		_ = c.Error(apperr.Internal(err))
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ticket":     plain,
		"expires_at": expires.UTC().Format(time.RFC3339Nano),
		// The client is told where to connect so it never has to construct the URL.
		"url": "/api/v1/ws?ticket=" + plain,
	})
}

// Connect upgrades the request after redeeming its ticket.
func (h *Handler) Connect(c *gin.Context) {
	ticket, err := h.tickets.Consume(c.Query("ticket"))
	if err != nil {
		// 401 rather than 400: the ticket is a credential, and its failure mode is the
		// same as any other rejected credential.
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "invalid_ws_ticket"))
		return
	}

	// Origin policy: the request host is always accepted. Without explicit origin
	// patterns only a same-origin handshake is allowed (the browser sends Origin, and
	// a page on another site cannot forge it). A CLI client that sends no Origin is
	// accepted too, which keeps native tooling working. Configuring OriginPatterns
	// opts into a cross-origin allow list; the request host stays authorized.
	options := &websocket.AcceptOptions{}
	if len(h.origins) > 0 {
		options.OriginPatterns = h.origins
	}

	conn, err := websocket.Accept(c.Writer, c.Request, options)
	if err != nil {
		return
	}
	defer conn.CloseNow()

	ctx := c.Request.Context()
	send := func(event Event) {
		payload, marshalErr := json.Marshal(event)
		if marshalErr != nil {
			return
		}
		writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_ = conn.Write(writeCtx, websocket.MessageText, payload)
	}

	unsubscribe := h.hub.Subscribe(ticket.SiteID, ticket.UserID, send)
	defer unsubscribe()

	// The client only ever receives; reading keeps the connection healthy and detects
	// disconnects so the subscriber does not leak.
	for {
		if _, _, readErr := conn.Read(ctx); readErr != nil {
			return
		}
	}
}
