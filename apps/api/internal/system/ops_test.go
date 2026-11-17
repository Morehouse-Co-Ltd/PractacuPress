package system

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/observability"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	ginmiddleware "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// fakeQueueStore records what the handler asked for and returns scripted values.
type fakeQueueStore struct {
	status      QueueStatus
	statusErr   error
	gotSiteID   string
	gotNow      time.Time
	retryCount  int
	retryErr    error
	retryCalls  int
	retryIDs    []string
	retrySiteID string
	retryLimit  int
	statusCalls int
}

func (f *fakeQueueStore) Status(_ context.Context, siteID string, now time.Time) (QueueStatus, error) {
	f.statusCalls++
	f.gotSiteID = siteID
	f.gotNow = now
	return f.status, f.statusErr
}

func (f *fakeQueueStore) RetryFailed(
	_ context.Context,
	siteID string,
	eventIDs []string,
	limit int,
) (int, error) {
	f.retryCalls++
	f.retrySiteID = siteID
	f.retryIDs = eventIDs
	f.retryLimit = limit
	return f.retryCount, f.retryErr
}

// opsTestClock is the fixed instant the handler uses for queue ages.
var opsTestClock = time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)

// installOpsRoutes mounts the operations handler the way the router does. The
// fake guard reads the caller from headers so each test can act as a different
// role without a token issuer.
func installOpsRoutes(t *testing.T, logs *observability.Recorder, queue QueueStore) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(ginmiddleware.RequestID(), ginmiddleware.ErrorHandler(nil))
	handler := NewOpsHandler(logs, queue, OpsHandlerConfig{
		Principal: func(c *gin.Context) (OpsPrincipal, bool) {
			role := c.GetHeader("X-Test-Role")
			if role == "" {
				return OpsPrincipal{}, false
			}
			return OpsPrincipal{
				UserID: "user-1",
				SiteID: c.GetHeader("X-Test-Site"),
				Role:   site.Role(role),
			}, true
		},
		Now: func() time.Time { return opsTestClock },
	})
	noop := func(c *gin.Context) { c.Next() }
	handler.Routes(engine.Group("/api/v1"), noop)
	return engine
}

// opsRequest builds one request with the fake principal headers.
func opsRequest(method, path, role, siteID, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("X-Test-Role", role)
	request.Header.Set("X-Test-Site", siteID)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func serveOps(engine *gin.Engine, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	return response
}

// TestOpsEndpointsRequireASiteAdministrator covers 401 and 403 on both panels.
func TestOpsEndpointsRequireASiteAdministrator(t *testing.T) {
	engine := installOpsRoutes(t, observability.NewRecorder(), &fakeQueueStore{})

	for _, path := range []string{"/api/v1/system/logs", "/api/v1/system/queue"} {
		anonymous := serveOps(engine, opsRequest(http.MethodGet, path, "", "", ""))
		require.Equal(t, http.StatusUnauthorized, anonymous.Code, path)

		member := serveOps(engine, opsRequest(http.MethodGet, path, string(site.RoleMember), "site-a", ""))
		require.Equal(t, http.StatusForbidden, member.Code, path)
		require.Contains(t, member.Body.String(), `"reason":"administrator_required"`)
	}

	editor := serveOps(engine, opsRequest(http.MethodGet, "/api/v1/system/queue", string(site.RoleEditor), "site-a", ""))
	require.Equal(t, http.StatusForbidden, editor.Code)
}

// TestLogsScopesASiteAdminToTheirSite proves tenant isolation of the request
// metadata: a site administrator never sees another site's traffic.
func TestLogsScopesASiteAdminToTheirSite(t *testing.T) {
	logs := observability.NewRecorder()
	logs.Append(observability.Entry{RequestID: "a", Method: "GET", Path: "/api/v1/articles", Status: 200, SiteID: "site-a"})
	logs.Append(observability.Entry{RequestID: "b", Method: "GET", Path: "/api/v1/articles", Status: 500, SiteID: "site-b"})
	logs.Append(observability.Entry{RequestID: "c", Method: "POST", Path: "/api/v1/media", Status: 201, SiteID: "site-a"})
	engine := installOpsRoutes(t, logs, &fakeQueueStore{})

	siteAdmin := serveOps(engine, opsRequest(http.MethodGet, "/api/v1/system/logs", string(site.RoleSiteAdmin), "site-a", ""))
	require.Equal(t, http.StatusOK, siteAdmin.Code)
	require.Equal(t, "no-store", siteAdmin.Header().Get("Cache-Control"))
	var siteBody struct {
		Items []observability.Entry `json:"items"`
	}
	require.NoError(t, json.Unmarshal(siteAdmin.Body.Bytes(), &siteBody))
	require.Len(t, siteBody.Items, 2)
	for _, item := range siteBody.Items {
		require.Equal(t, "site-a", item.SiteID)
	}

	platform := serveOps(engine, opsRequest(http.MethodGet, "/api/v1/system/logs", string(site.RolePlatformAdmin), "site-a", ""))
	require.Equal(t, http.StatusOK, platform.Code)
	var platformBody struct {
		Items []observability.Entry `json:"items"`
	}
	require.NoError(t, json.Unmarshal(platform.Body.Bytes(), &platformBody))
	require.Len(t, platformBody.Items, 3, "the platform administrator sees the whole deployment")
}

// TestLogsAppliesTheDocumentedFilters covers status, method and path.
func TestLogsAppliesTheDocumentedFilters(t *testing.T) {
	logs := observability.NewRecorder()
	logs.Append(observability.Entry{Method: "GET", Path: "/api/v1/articles", Status: 200, SiteID: "site-a"})
	logs.Append(observability.Entry{Method: "POST", Path: "/api/v1/articles", Status: 201, SiteID: "site-a"})
	logs.Append(observability.Entry{Method: "GET", Path: "/api/v1/media/1", Status: 404, SiteID: "site-a"})
	engine := installOpsRoutes(t, logs, &fakeQueueStore{})

	filtered := serveOps(engine, opsRequest(http.MethodGet,
		"/api/v1/system/logs?status=404&method=get&path=media&limit=10",
		string(site.RoleSiteAdmin), "site-a", ""))
	require.Equal(t, http.StatusOK, filtered.Code)
	var body struct {
		Items []observability.Entry `json:"items"`
	}
	require.NoError(t, json.Unmarshal(filtered.Body.Bytes(), &body))
	require.Len(t, body.Items, 1)
	require.Equal(t, "/api/v1/media/1", body.Items[0].Path)

	for _, query := range []string{"limit=0", "limit=101", "limit=abc", "status=abc", "status=42"} {
		response := serveOps(engine, opsRequest(http.MethodGet,
			"/api/v1/system/logs?"+query, string(site.RoleSiteAdmin), "site-a", ""))
		require.Equal(t, http.StatusBadRequest, response.Code, query)
	}
}

// TestLogsFailsClosedWithoutARecorder keeps a partial wiring honest.
func TestLogsFailsClosedWithoutARecorder(t *testing.T) {
	engine := installOpsRoutes(t, nil, &fakeQueueStore{})
	response := serveOps(engine, opsRequest(http.MethodGet, "/api/v1/system/logs", string(site.RoleSiteAdmin), "site-a", ""))
	require.Equal(t, http.StatusInternalServerError, response.Code)
}

// TestQueueScopesTheStorePerRole proves the tenant filter passed to the store.
func TestQueueScopesTheStorePerRole(t *testing.T) {
	store := &fakeQueueStore{status: QueueStatus{
		Outbox: QueueOutboxStats{Pending: 2, Failed: 1, OldestAgeSeconds: 90},
		Recent: []QueueEvent{{
			EventID: "evt-1", EventType: "content.published", Status: QueueEventFailed,
			Attempts: 3, LastError: "smtp timeout", OccurredAt: opsTestClock,
		}},
		Mail: QueueMailStats{Queued: 1, Failed: 0},
	}}
	engine := installOpsRoutes(t, observability.NewRecorder(), store)

	response := serveOps(engine, opsRequest(http.MethodGet, "/api/v1/system/queue", string(site.RoleSiteAdmin), "site-a", ""))
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, "site-a", store.gotSiteID)
	require.Equal(t, opsTestClock, store.gotNow)

	var body QueueStatus
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, 2, body.Outbox.Pending)
	require.Equal(t, int64(90), body.Outbox.OldestAgeSeconds)
	require.Len(t, body.Recent, 1)
	require.Equal(t, QueueEventFailed, body.Recent[0].Status)
	require.Equal(t, 1, body.Mail.Queued)

	platform := serveOps(engine, opsRequest(http.MethodGet, "/api/v1/system/queue", string(site.RolePlatformAdmin), "site-a", ""))
	require.Equal(t, http.StatusOK, platform.Code)
	require.Empty(t, store.gotSiteID, "the platform administrator asks for the whole deployment")
}

// TestQueueRetryForwardsTheSelection covers both retry shapes and validation.
func TestQueueRetryForwardsTheSelection(t *testing.T) {
	store := &fakeQueueStore{retryCount: 2}
	engine := installOpsRoutes(t, observability.NewRecorder(), store)

	withIDs := serveOps(engine, opsRequest(http.MethodPost, "/api/v1/system/queue/retry",
		string(site.RoleSiteAdmin), "site-a", `{"event_ids":["evt-1","evt-2"]}`))
	require.Equal(t, http.StatusOK, withIDs.Code)
	require.Contains(t, withIDs.Body.String(), `"retried":2`)
	require.Equal(t, []string{"evt-1", "evt-2"}, store.retryIDs)
	require.Equal(t, "site-a", store.retrySiteID)
	require.Equal(t, QueueRetryDefaultLimit, store.retryLimit)

	// An empty body means "the newest failed events": no ids are forwarded.
	emptyBody := serveOps(engine, opsRequest(http.MethodPost, "/api/v1/system/queue/retry",
		string(site.RoleSiteAdmin), "site-a", ""))
	require.Equal(t, http.StatusOK, emptyBody.Code)
	require.Empty(t, store.retryIDs)

	malformed := serveOps(engine, opsRequest(http.MethodPost, "/api/v1/system/queue/retry",
		string(site.RolePlatformAdmin), "site-a", `{"event_ids":`))
	require.Equal(t, http.StatusBadRequest, malformed.Code)

	tooManyIDs := make([]string, MaxQueueRetryIDs+1)
	for index := range tooManyIDs {
		tooManyIDs[index] = "evt-x"
	}
	tooManyBody, err := json.Marshal(map[string]any{"event_ids": tooManyIDs})
	require.NoError(t, err)
	response := serveOps(engine, opsRequest(http.MethodPost, "/api/v1/system/queue/retry",
		string(site.RolePlatformAdmin), "site-a", string(tooManyBody)))
	require.Equal(t, http.StatusBadRequest, response.Code)
	require.Equal(t, 2, store.retryCalls, "a rejected request never reaches the store")
}

// TestQueueFailsClosedWithoutAStore keeps a partial wiring honest.
func TestQueueFailsClosedWithoutAStore(t *testing.T) {
	engine := installOpsRoutes(t, observability.NewRecorder(), nil)
	response := serveOps(engine, opsRequest(http.MethodGet, "/api/v1/system/queue", string(site.RoleSiteAdmin), "site-a", ""))
	require.Equal(t, http.StatusInternalServerError, response.Code)
}
