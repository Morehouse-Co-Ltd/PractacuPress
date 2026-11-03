package taxonomy

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

func newHandlerEngine(t *testing.T, repo *fakeRepo) *gin.Engine {
	t.Helper()
	return newHandlerEngineWithVisibility(t, repo, site.VisibilityPublic)
}

func newHandlerEngineWithVisibility(t *testing.T, repo *fakeRepo, visibility site.VisibilityMode) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	service := newTestService(t, repo)
	handler := NewHandler(service, HandlerConfig{
		Principal: func(c *gin.Context) (Actor, bool) {
			if c.GetHeader("X-Test-Principal") == "" {
				return Actor{}, false
			}
			role := site.RoleSiteAdmin
			if c.GetHeader("X-Test-Role") == "member" {
				role = site.RoleMember
			}
			return Actor{UserID: "u1", SiteID: "site_1", Role: role}, true
		},
		Site: func(c *gin.Context) (site.Site, bool) {
			if resolved := c.GetHeader("X-Test-Site"); resolved != "" {
				return site.Site{ID: resolved}, true
			}
			return site.Site{ID: "site_1", VisibilityMode: visibility}, true
		},
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

func TestHandlerListsTaxonomyAnonymously(t *testing.T) {
	repo := &fakeRepo{terms: []Term{
		{ID: "c1", SiteID: "site_1", Kind: KindCategory, Name: "Craft", Slug: "craft", Color: "#2f6b4f"},
		{ID: "t1", SiteID: "site_1", Kind: KindTag, Name: "Go", Slug: "go"},
	}}
	engine := newHandlerEngine(t, repo)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/site_1/taxonomy", nil)
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	var payload struct {
		Categories []termResponse `json:"categories"`
		Tags       []termResponse `json:"tags"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))
	require.Len(t, payload.Categories, 1)
	require.Len(t, payload.Tags, 1)
	require.Equal(t, "category", payload.Categories[0].Kind)
	require.Equal(t, "tag", payload.Tags[0].Kind)
	require.Equal(t, "Craft", payload.Categories[0].Name)
}

func TestHandlerRejectsForeignSiteRead(t *testing.T) {
	engine := newHandlerEngine(t, &fakeRepo{})

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/site_1/taxonomy", nil)
	request.Header.Set("X-Test-Site", "site_2")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusForbidden, recorder.Code)
}

// TestHandlerRefusesAnonymousReadOnMembersOnlySite is the V-11 regression: taxonomy
// names describe content a members-only site hides, so an anonymous reader must get
// the same 401 that every other read endpoint returns.
func TestHandlerRefusesAnonymousReadOnMembersOnlySite(t *testing.T) {
	repo := &fakeRepo{terms: []Term{
		{ID: "c1", SiteID: "site_1", Kind: KindCategory, Name: "Secret Category", Slug: "secret"},
	}}
	engine := newHandlerEngineWithVisibility(t, repo, site.VisibilityMembersOnly)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/site_1/taxonomy", nil)
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusUnauthorized, recorder.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))
	require.Equal(t, "unauthenticated", payload["code"])
	require.NotContains(t, recorder.Body.String(), "Secret Category",
		"the refusal must not leak the terms it protects")
}

// TestHandlerAllowsMemberReadOnMembersOnlySite keeps the fix precise: a session scoped
// to the site still gets the taxonomy, because its pages render the navigation.
func TestHandlerAllowsMemberReadOnMembersOnlySite(t *testing.T) {
	repo := &fakeRepo{terms: []Term{
		{ID: "t1", SiteID: "site_1", Kind: KindTag, Name: "Go", Slug: "go"},
	}}
	engine := newHandlerEngineWithVisibility(t, repo, site.VisibilityMembersOnly)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/site_1/taxonomy", nil)
	request.Header.Set("X-Test-Principal", "1")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var payload termListResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))
	require.Len(t, payload.Tags, 1)
}

func TestHandlerTaxonomyWrites(t *testing.T) {
	repo := &fakeRepo{}
	engine := newHandlerEngine(t, repo)

	// Anonymous create is rejected.
	request := httptest.NewRequest(http.MethodPost, "/api/v1/sites/site_1/taxonomy",
		bytes.NewReader([]byte(`{"kind":"category","name":"Craft","slug":"craft","color":"#2f6b4f"}`)))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusUnauthorized, recorder.Code)

	// A plain member is rejected.
	request = httptest.NewRequest(http.MethodPost, "/api/v1/sites/site_1/taxonomy",
		bytes.NewReader([]byte(`{"kind":"category","name":"Craft","slug":"craft"}`)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Test-Principal", "1")
	request.Header.Set("X-Test-Role", "member")
	recorder = httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusForbidden, recorder.Code)

	// A site administrator creates it.
	request = httptest.NewRequest(http.MethodPost, "/api/v1/sites/site_1/taxonomy",
		bytes.NewReader([]byte(`{"kind":"category","name":"Craft","slug":"craft","color":"#2f6b4f"}`)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Test-Principal", "1")
	recorder = httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())

	var created termResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &created))
	require.Equal(t, "category", created.Kind)
	require.Equal(t, "craft", created.Slug)

	// Partial update keeps the slug.
	request = httptest.NewRequest(http.MethodPatch, "/api/v1/sites/site_1/taxonomy/"+created.ID,
		bytes.NewReader([]byte(`{"description":"notes"}`)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Test-Principal", "1")
	recorder = httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
	var updated termResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &updated))
	require.Equal(t, "craft", updated.Slug)
	require.Equal(t, "notes", updated.Description)

	// Delete answers 204.
	request = httptest.NewRequest(http.MethodDelete, "/api/v1/sites/site_1/taxonomy/"+created.ID, nil)
	request.Header.Set("X-Test-Principal", "1")
	recorder = httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusNoContent, recorder.Code)
	require.Len(t, repo.deleted, 1)
}
