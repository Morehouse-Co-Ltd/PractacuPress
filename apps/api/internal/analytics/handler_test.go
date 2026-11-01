package analytics

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

func newHandlerEngine(t *testing.T, repo *fakeRepo, now time.Time) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	service, err := NewService(ServiceConfig{Repository: repo, Now: func() time.Time { return now }})
	require.NoError(t, err)

	handler := NewHandler(service, HandlerConfig{
		Principal: func(c *gin.Context) (Actor, bool) {
			if c.GetHeader("X-Test-Principal") == "" {
				return Actor{}, false
			}
			return Actor{UserID: "u1", SiteID: "site_1", Role: site.RoleSiteAdmin}, true
		},
		Site: func(*gin.Context) (site.Site, bool) { return site.Site{ID: "site_1"}, true },
	})

	engine := gin.New()
	engine.Use(
		middleware.RequestID(),
		middleware.ErrorHandler(slog.New(slog.NewTextHandler(io.Discard, nil))),
	)
	noop := func(c *gin.Context) { c.Next() }
	handler.Routes(engine.Group("/api/v1"), noop, noop)
	return engine
}

func TestHandlerRecordsVisitAnonymously(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{}
	engine := newHandlerEngine(t, repo, now)

	body := []byte(`{"path":"/a/cnt_1","title":"Hello","referrer":"","session":"vs_1","surface":"site"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/visits", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusNoContent, recorder.Code)
	require.Len(t, repo.visits, 1)
	require.Equal(t, "site_1", repo.visits[0].SiteID, "the site comes from resolution, not the body")
	require.Equal(t, "/a/cnt_1", repo.visits[0].Path)
}

func TestHandlerRejectsInvalidVisit(t *testing.T) {
	engine := newHandlerEngine(t, &fakeRepo{}, time.Now())

	request := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/visits",
		bytes.NewReader([]byte(`{"path":"relative","session":"vs_1","surface":"site"}`)))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusBadRequest, recorder.Code)
}

func TestHandlerReport(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{aggregate: Aggregate{Views: 1, Sessions: 1, Online: 1}}
	engine := newHandlerEngine(t, repo, now)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/site_1/analytics?range=7d", nil)
	request.Header.Set("X-Test-Principal", "1")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	var payload struct {
		Range  string `json:"range"`
		Totals struct {
			Views int `json:"views"`
		} `json:"totals"`
		Series     []map[string]any `json:"series"`
		TopPages   []map[string]any `json:"top_pages"`
		TopContent []map[string]any `json:"top_content"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))
	require.Equal(t, "7d", payload.Range)
	require.Equal(t, 1, payload.Totals.Views)
	require.Len(t, payload.Series, 7)
	require.NotNil(t, payload.TopPages)
	require.NotNil(t, payload.TopContent)
}

func TestHandlerReportRequiresPrincipal(t *testing.T) {
	engine := newHandlerEngine(t, &fakeRepo{}, time.Now())

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/site_1/analytics", nil)
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusUnauthorized, recorder.Code)
}
