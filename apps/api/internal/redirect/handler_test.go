package redirect

import (
	"bytes"
	"encoding/json"
	"errors"
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

// newHandlerEngine mounts the handler the way the router does, behind the error
// translator and the versioned group's tests.
func newHandlerEngine(t *testing.T, repo *fakeRepo, locator *fakeLocator) *gin.Engine {
	t.Helper()

	return newHandlerEngineWithConfig(t, repo, locator, HandlerConfig{})
}

func newHandlerEngineWithConfig(
	t *testing.T,
	repo *fakeRepo,
	locator *fakeLocator,
	cfg HandlerConfig,
) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	service := newTestService(t, repo, locator)
	if cfg.Principal == nil {
		cfg.Principal = func(c *gin.Context) (site.Member, bool) {
			if c.GetHeader("X-Test-Principal") == "" {
				return site.Member{}, false
			}
			role := site.RoleSiteAdmin
			switch c.GetHeader("X-Test-Role") {
			case "member":
				role = site.RoleMember
			case "editor":
				role = site.RoleEditor
			}
			return site.Member{
				UserID: "user_1",
				SiteID: "site_1",
				Role:   role,
				Status: site.MemberStatusActive,
			}, true
		}
	}
	if cfg.Site == nil {
		cfg.Site = func(c *gin.Context) (site.Site, bool) {
			if c.GetHeader("X-Test-No-Site") != "" {
				return site.Site{}, false
			}
			if resolved := c.GetHeader("X-Test-Site"); resolved != "" {
				return site.Site{ID: resolved}, true
			}
			return site.Site{ID: "site_1"}, true
		}
	}

	handler := NewHandler(service, cfg)

	engine := gin.New()
	engine.Use(
		middleware.RequestID(),
		middleware.ErrorHandler(slog.New(slog.NewTextHandler(io.Discard, nil))),
	)
	handler.Routes(engine.Group("/api/v1"), func(c *gin.Context) { c.Next() })
	return engine
}

// doRequest sends one request with optional JSON body and headers.
func doRequest(
	t *testing.T,
	engine *gin.Engine,
	method, path, body string,
	headers map[string]string,
) *httptest.ResponseRecorder {
	t.Helper()

	var reader io.Reader
	if body != "" {
		reader = bytes.NewReader([]byte(body))
	}
	request := httptest.NewRequest(method, path, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}

	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	return recorder
}

func decodeResolve(t *testing.T, recorder *httptest.ResponseRecorder) resolveResponse {
	t.Helper()

	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var payload resolveResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))
	return payload
}

func decodeProblem(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()

	var problem map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &problem))
	return problem
}

func TestResolveEndpointReportsTheFourOutcomes(t *testing.T) {
	repo := newFakeRepo(Redirect{
		ID: "rule_1", SiteID: "site_1", FromPath: "/a/moved", ToPath: "/a/new",
		StatusCode: 301, Source: SourceManual,
	})
	locator := newFakeLocator()
	locator.add(LocateKindArticle, "content_1", "content_1", "hello-world", "Hello")
	locator.add(LocateKindArticle, "hello-world", "content_1", "hello-world", "Hello")
	locator.add(LocateKindPost, "content_2", "content_2", "release-notes", "Notes")
	engine := newHandlerEngine(t, repo, locator)

	// An id style article path is redirected to its slug form.
	payload := decodeResolve(t, doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/content_1", "", nil))
	require.Equal(t, string(KindContent), payload.Kind)
	require.Equal(t, 301, payload.Status)
	require.Equal(t, "/a/hello-world", payload.CanonicalPath)
	require.Equal(t, "content_1", payload.ContentID)
	require.Equal(t, "hello-world", payload.Slug)
	require.Equal(t, "Hello", payload.Title)

	// An id style post path works the same way under /p/.
	payload = decodeResolve(t, doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/p/content_2", "", nil))
	require.Equal(t, 301, payload.Status)
	require.Equal(t, "/p/release-notes", payload.CanonicalPath)

	// The slug form is the canonical address already.
	payload = decodeResolve(t, doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/hello-world", "", nil))
	require.Equal(t, string(KindContent), payload.Kind)
	require.Equal(t, 200, payload.Status)
	require.Equal(t, "/a/hello-world", payload.CanonicalPath)

	// A rule in the redirect table wins and reports its own status code.
	payload = decodeResolve(t, doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/moved", "", nil))
	require.Equal(t, string(KindRedirect), payload.Kind)
	require.Equal(t, 301, payload.Status)
	require.Equal(t, "/a/new", payload.CanonicalPath)
	require.Empty(t, payload.ContentID)

	// Nothing owns the path.
	payload = decodeResolve(t, doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/gone", "", nil))
	require.Equal(t, string(KindMissing), payload.Kind)
	require.Equal(t, 404, payload.Status)
	require.Equal(t, "/a/gone", payload.CanonicalPath)

	// The endpoint itself always answers 200: it is a lookup, not the page.
	recorder := doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/gone", "", nil)
	require.Equal(t, http.StatusOK, recorder.Code)
}

func TestResolveEndpointNormalisesTheQueryPath(t *testing.T) {
	locator := newFakeLocator()
	locator.add(LocateKindArticle, "hello-world", "content_1", "hello-world", "Hello")
	engine := newHandlerEngine(t, newFakeRepo(), locator)

	recorder := doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=%20%2Fa%2Fhello-world%2F%3Futm%3D1%20", "", nil)
	payload := decodeResolve(t, recorder)
	require.Equal(t, 200, payload.Status)
	require.Equal(t, "/a/hello-world", payload.CanonicalPath)
}

func TestResolveEndpointCachesSuccessfulLookups(t *testing.T) {
	locator := newFakeLocator()
	locator.add(LocateKindArticle, "content_1", "content_1", "hello-world", "Hello")
	engine := newHandlerEngine(t, newFakeRepo(), locator)

	first := decodeResolve(t, doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/content_1", "", nil))
	second := decodeResolve(t, doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/content_1?utm=2", "", nil))

	require.Equal(t, first, second)
	require.Equal(t, 1, locator.callCount(), "the second lookup is served from the in-process cache")
}

func TestResolveEndpointDoesNotCacheFailures(t *testing.T) {
	locator := newFakeLocator()
	locator.add(LocateKindArticle, "content_1", "content_1", "hello-world", "Hello")
	locator.errs = []error{errors.New("content store down")}
	engine := newHandlerEngine(t, newFakeRepo(), locator)

	failed := doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/content_1", "", nil)
	require.Equal(t, http.StatusInternalServerError, failed.Code)
	require.Equal(t, "internal", decodeProblem(t, failed)["code"])

	recovered := decodeResolve(t, doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/content_1", "", nil))
	require.Equal(t, 301, recovered.Status)
	require.Equal(t, 2, locator.callCount(), "a failure is retried instead of cached")
}

func TestResolveEndpointRequiresPathAndSite(t *testing.T) {
	engine := newHandlerEngine(t, newFakeRepo(), newFakeLocator())

	missing := doRequest(t, engine, http.MethodGet, "/api/v1/resolve", "", nil)
	require.Equal(t, http.StatusBadRequest, missing.Code)
	require.Equal(t, "validation_failed", decodeProblem(t, missing)["code"])

	noSite := doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/foo", "",
		map[string]string{"X-Test-No-Site": "1"})
	require.Equal(t, http.StatusNotFound, noSite.Code)
	require.Equal(t, "site_not_found", decodeProblem(t, noSite)["code"])
}

func TestRedirectManagementRequiresManageSite(t *testing.T) {
	repo := newFakeRepo()
	engine := newHandlerEngine(t, repo, newFakeLocator())

	anonymous := doRequest(t, engine, http.MethodPost, "/api/v1/sites/site_1/redirects",
		`{"from_path":"/a/old","to_path":"/a/new"}`, nil)
	require.Equal(t, http.StatusUnauthorized, anonymous.Code)
	require.Equal(t, "unauthenticated", decodeProblem(t, anonymous)["code"])

	member := doRequest(t, engine, http.MethodPost, "/api/v1/sites/site_1/redirects",
		`{"from_path":"/a/old","to_path":"/a/new"}`,
		map[string]string{"X-Test-Principal": "1", "X-Test-Role": "member"})
	require.Equal(t, http.StatusForbidden, member.Code)
	require.Equal(t, "permission_denied", decodeProblem(t, member)["code"])

	editor := doRequest(t, engine, http.MethodGet, "/api/v1/sites/site_1/redirects", "",
		map[string]string{"X-Test-Principal": "1", "X-Test-Role": "editor"})
	require.Equal(t, http.StatusForbidden, editor.Code)
}

func TestRedirectManagementCrossSitePathIsRefused(t *testing.T) {
	engine := newHandlerEngine(t, newFakeRepo(), newFakeLocator())

	recorder := doRequest(t, engine, http.MethodGet, "/api/v1/sites/site_2/redirects", "",
		map[string]string{"X-Test-Principal": "1"})
	require.Equal(t, http.StatusForbidden, recorder.Code)
	require.Equal(t, "cross_site", decodeProblem(t, recorder)["details"].(map[string]any)["reason"])
}

func TestRedirectManagementCRUD(t *testing.T) {
	repo := newFakeRepo()
	engine := newHandlerEngine(t, repo, newFakeLocator())
	admin := map[string]string{"X-Test-Principal": "1"}

	// Create normalises the path and defaults the status code.
	created := doRequest(t, engine, http.MethodPost, "/api/v1/sites/site_1/redirects",
		`{"from_path":"/a/old/","to_path":" /a/new "}`, admin)
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	var rule redirectResponse
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &rule))
	require.NotEmpty(t, rule.ID)
	require.Equal(t, "/a/old", rule.FromPath)
	require.Equal(t, "/a/new", rule.ToPath)
	require.Equal(t, 301, rule.StatusCode)
	require.Equal(t, string(SourceManual), rule.Source)
	require.Equal(t, 0, rule.HitCount)
	require.NotEmpty(t, rule.CreatedAt)
	require.NotEmpty(t, rule.UpdatedAt)

	// A duplicate from_path is a conflict, whatever spelling it uses.
	duplicate := doRequest(t, engine, http.MethodPost, "/api/v1/sites/site_1/redirects",
		`{"from_path":"/a/old?x=1","to_path":"/a/other"}`, admin)
	require.Equal(t, http.StatusConflict, duplicate.Code)
	require.Equal(t, "conflict", decodeProblem(t, duplicate)["code"])

	// Listing carries the pagination envelope.
	list := doRequest(t, engine, http.MethodGet, "/api/v1/sites/site_1/redirects", "", admin)
	require.Equal(t, http.StatusOK, list.Code)
	var page redirectListResponse
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	require.Empty(t, page.NextCursor)
	require.False(t, page.HasMore)

	// Update is partial: the omitted from_path is kept.
	updated := doRequest(t, engine, http.MethodPatch, "/api/v1/sites/site_1/redirects/"+rule.ID,
		`{"to_path":"/a/newer","status_code":308}`, admin)
	require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
	var updatedRule redirectResponse
	require.NoError(t, json.Unmarshal(updated.Body.Bytes(), &updatedRule))
	require.Equal(t, "/a/old", updatedRule.FromPath)
	require.Equal(t, "/a/newer", updatedRule.ToPath)
	require.Equal(t, 308, updatedRule.StatusCode)

	missing := doRequest(t, engine, http.MethodPatch, "/api/v1/sites/site_1/redirects/missing",
		`{"to_path":"/a/x"}`, admin)
	require.Equal(t, http.StatusNotFound, missing.Code)

	// Delete answers 204 and the second delete is a 404.
	deleted := doRequest(t, engine, http.MethodDelete, "/api/v1/sites/site_1/redirects/"+rule.ID, "", admin)
	require.Equal(t, http.StatusNoContent, deleted.Code)

	again := doRequest(t, engine, http.MethodDelete, "/api/v1/sites/site_1/redirects/"+rule.ID, "", admin)
	require.Equal(t, http.StatusNotFound, again.Code)

	empty := doRequest(t, engine, http.MethodGet, "/api/v1/sites/site_1/redirects", "", admin)
	require.NoError(t, json.Unmarshal(empty.Body.Bytes(), &page))
	require.Empty(t, page.Items)
}

func TestRedirectManagementRejectsInvalidInput(t *testing.T) {
	engine := newHandlerEngine(t, newFakeRepo(), newFakeLocator())
	admin := map[string]string{"X-Test-Principal": "1"}

	badStatus := doRequest(t, engine, http.MethodPost, "/api/v1/sites/site_1/redirects",
		`{"from_path":"/a/old","to_path":"/a/new","status_code":307}`, admin)
	require.Equal(t, http.StatusBadRequest, badStatus.Code)
	problem := decodeProblem(t, badStatus)
	require.Equal(t, "validation_failed", problem["code"])
	require.Equal(t, "status_code", problem["details"].(map[string]any)["field"])

	malformed := doRequest(t, engine, http.MethodPost, "/api/v1/sites/site_1/redirects",
		`{not json`, admin)
	require.Equal(t, http.StatusBadRequest, malformed.Code)
}

func TestRedirectManagementPaginationAndCursorValidation(t *testing.T) {
	repo := newFakeRepo(
		Redirect{ID: "rule_1", SiteID: "site_1", FromPath: "/a/one", ToPath: "/a/x", StatusCode: 301, Source: SourceManual, CreatedAt: testNow},
		Redirect{ID: "rule_2", SiteID: "site_1", FromPath: "/a/two", ToPath: "/a/y", StatusCode: 301, Source: SourceManual, CreatedAt: testNow.Add(time.Minute)},
	)
	engine := newHandlerEngine(t, repo, newFakeLocator())
	admin := map[string]string{"X-Test-Principal": "1"}

	first := doRequest(t, engine, http.MethodGet, "/api/v1/sites/site_1/redirects?limit=1", "", admin)
	require.Equal(t, http.StatusOK, first.Code)
	var page redirectListResponse
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	require.True(t, page.HasMore)
	require.NotEmpty(t, page.NextCursor)

	second := doRequest(t, engine, http.MethodGet,
		"/api/v1/sites/site_1/redirects?limit=1&cursor="+page.NextCursor, "", admin)
	require.Equal(t, http.StatusOK, second.Code)
	require.NoError(t, json.Unmarshal(second.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	require.False(t, page.HasMore)

	// Fuzzy search covers both sides of the rule.
	search := doRequest(t, engine, http.MethodGet, "/api/v1/sites/site_1/redirects?q=%2Fa%2Fy", "", admin)
	require.NoError(t, json.Unmarshal(search.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	require.Equal(t, "rule_2", page.Items[0].ID)

	badCursor := doRequest(t, engine, http.MethodGet, "/api/v1/sites/site_1/redirects?cursor=not-a-cursor", "", admin)
	require.Equal(t, http.StatusBadRequest, badCursor.Code)
	require.Equal(t, "invalid_cursor", decodeProblem(t, badCursor)["code"])

	badLimit := doRequest(t, engine, http.MethodGet, "/api/v1/sites/site_1/redirects?limit=500", "", admin)
	require.Equal(t, http.StatusBadRequest, badLimit.Code)
}

func TestRedirectManagementWriteInvalidatesResolveCache(t *testing.T) {
	repo := newFakeRepo()
	engine := newHandlerEngine(t, repo, newFakeLocator())
	admin := map[string]string{"X-Test-Principal": "1"}

	// The path is resolved and cached as missing.
	before := decodeResolve(t, doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/old", "", nil))
	require.Equal(t, string(KindMissing), before.Kind)

	// Adding the rule must be visible immediately, not after the cache TTL.
	created := doRequest(t, engine, http.MethodPost, "/api/v1/sites/site_1/redirects",
		`{"from_path":"/a/old","to_path":"/a/new"}`, admin)
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	after := decodeResolve(t, doRequest(t, engine, http.MethodGet, "/api/v1/resolve?path=/a/old", "", nil))
	require.Equal(t, string(KindRedirect), after.Kind)
	require.Equal(t, "/a/new", after.CanonicalPath)
}
