package ws_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/messagingstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/outboxstore"
	"github.com/practacu/practacu-press/apps/api/internal/messaging"
	"github.com/practacu/practacu-press/apps/api/internal/outbox"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/transport/ws"
)

// harness wires the real store, the real worker and the real hub together, so the test
// proves the loop rather than a mock of it.
type harness struct {
	db      *db.DB
	hub     *ws.Hub
	tickets *ws.TicketStore
	service *messaging.Service
	worker  *outbox.Worker
	siteID  string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "ws.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	hub := ws.NewHub()

	service, err := messaging.NewService(messagingstore.New(handle.Client))
	require.NoError(t, err)

	worker, err := outbox.NewWorker(outbox.Config{
		Repository: outboxstore.New(handle.Client),
		Handler: outbox.HandlerFunc(func(ctx context.Context, event outbox.Event) error {
			occurred := time.Now().UTC()
			if raw, ok := event.Payload["occurred_at"].(string); ok {
				if parsed, parseErr := time.Parse(time.RFC3339Nano, raw); parseErr == nil {
					occurred = parsed
				}
			}
			hub.Publish(ctx, ws.Event{
				ID:             event.EventID,
				Type:           event.Type,
				OccurredAt:     occurred,
				SiteID:         event.SiteID,
				AudienceUserID: event.AudienceUserID,
				Payload:        event.Payload,
			})
			return nil
		}),
	})
	require.NoError(t, err)

	return &harness{
		db:      handle,
		hub:     hub,
		tickets: ws.NewTicketStore(nil),
		service: service,
		worker:  worker,
		siteID:  siteRow.ID,
	}
}

// connect opens a real WebSocket against the handler and returns the connection.
func (h *harness) connect(t *testing.T, userID string) *websocket.Conn {
	t.Helper()

	ticket, _, err := h.tickets.Issue(ws.Ticket{SiteID: h.siteID, UserID: userID})
	require.NoError(t, err)

	handler := ws.NewHandler(h.tickets, h.hub, ws.HandlerConfig{})
	r := ginEngineFor(handler)

	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws?ticket=" + ticket
	conn, _, err := websocket.Dial(context.Background(), url, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.CloseNow() })

	// Wait until the hub has registered the subscriber.
	deadline := time.Now().Add(2 * time.Second)
	for h.hub.Count() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	require.Greater(t, h.hub.Count(), 0, "the connection never subscribed")
	return conn
}

func TestMessageReachesOnlyTheRecipient(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	alice := messaging.Actor{UserID: "alice", SiteID: h.siteID}

	conversation, err := h.service.StartConversation(ctx, alice, messaging.KindDirect, []string{"bob"})
	require.NoError(t, err)

	bobConn := h.connect(t, "bob")
	aliceConn := h.connect(t, "alice")

	_, err = h.service.Send(ctx, alice, messaging.NewMessageInput{
		ConversationID: conversation.ID,
		Body:           "hello bob",
	})
	require.NoError(t, err)

	// One worker pass turns the committed outbox row into a push.
	result, err := h.worker.RunOnce(ctx, 10)
	require.NoError(t, err)
	require.Equal(t, 1, result.Published)

	readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	_, payload, err := bobConn.Read(readCtx)
	require.NoError(t, err)

	var event struct {
		Type       string `json:"type"`
		SiteID     string `json:"site_id"`
		OccurredAt string `json:"occurred_at"`
		Payload    struct {
			ConversationID string `json:"conversation_id"`
		} `json:"payload"`
	}
	require.NoError(t, json.Unmarshal(payload, &event))
	require.Equal(t, "message.created", event.Type)
	require.Equal(t, h.siteID, event.SiteID)
	require.Equal(t, conversation.ID, event.Payload.ConversationID)
	require.NotEmpty(t, event.OccurredAt)

	// Alice must not receive her own message.
	aliceCtx, aliceCancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer aliceCancel()
	_, _, err = aliceConn.Read(aliceCtx)
	require.Error(t, err, "the sender must not receive their own message event")
}

// TestSocketRejectsSpentTicket proves the ticket is a credential with a single use.
func TestSocketRejectsSpentTicket(t *testing.T) {
	h := newHarness(t)

	ticket, _, err := h.tickets.Issue(ws.Ticket{SiteID: h.siteID, UserID: "bob"})
	require.NoError(t, err)

	handler := ws.NewHandler(h.tickets, h.hub, ws.HandlerConfig{})
	server := httptest.NewServer(ginEngineFor(handler))
	t.Cleanup(server.Close)

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws?ticket=" + ticket
	conn, _, err := websocket.Dial(context.Background(), url, nil)
	require.NoError(t, err)
	_ = conn.CloseNow()

	// A second attempt with the same ticket must be refused.
	_, resp, err := websocket.Dial(context.Background(), url, nil)
	require.Error(t, err)
	if resp != nil {
		require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	}
}

// ginEngineFor mounts the WebSocket handler on a bare gin engine.
func ginEngineFor(handler *ws.Handler) http.Handler {
	engine := gin.New()
	// Mirror the production error translator, otherwise a rejected ticket would be
	// answered with an empty 200 instead of 401.
	engine.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	handler.Routes(engine, func(c *gin.Context) { c.Next() })
	return engine
}
