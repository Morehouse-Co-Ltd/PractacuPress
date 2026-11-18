package content_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

// trashEngine mounts both route groups. A nil actor resolves to an anonymous reader,
// which is what the visibility assertions below switch between.
func trashEngine(t *testing.T, repo *stubRepo, actor *content.Actor) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	service, err := content.NewService(content.ServiceConfig{
		Repository: repo,
		Sanitizer:  acceptingSanitizer{},
	})
	require.NoError(t, err)

	resolved := site.Site{ID: "s1", Slug: "main", VisibilityMode: site.VisibilityPublic}
	handler := content.NewHandler(service, content.HandlerConfig{
		Principal: func(*gin.Context) (content.Actor, bool) {
			if actor == nil {
				return content.Actor{}, false
			}
			return *actor, true
		},
		Site: func(*gin.Context) (site.Site, bool) { return resolved, true },
	})

	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	anonymous := func(c *gin.Context) { c.Next() }
	handler.Routes(r, anonymous, anonymous)
	return r
}

// liveItemRepo seeds one published article owned by "author".
func liveItemRepo() *stubRepo {
	return &stubRepo{items: []content.Content{{
		ID: "live", SiteID: "s1", AuthorID: "author", Kind: content.KindArticle,
		Status: content.StatusPublished, Title: "Live", RenderedHTML: "<p>hi</p>",
		CreatedAt: time.Unix(0, 0).UTC(),
	}}}
}

func authorActor() *content.Actor {
	return &content.Actor{UserID: "author", SiteID: "s1", Role: site.RoleMember}
}

// TestTrashEndpointsMoveAnItemInAndOutOfTheBin pins the HTTP contract of the recycle
// bin: DELETE trashes and answers with the trashed view, the bin listing is author or
// editor only, and the detail read is a flat 404 so existence is never disclosed.
func TestTrashEndpointsMoveAnItemInAndOutOfTheBin(t *testing.T) {
	repo := liveItemRepo()
	r := trashEngine(t, repo, authorActor())
	anonymous := trashEngine(t, repo, nil)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/articles/live", nil))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"deleted_at"`)
	require.Contains(t, w.Body.String(), `"actions":["undelete","purge"]`)

	// The detail read hides the item from everybody who can no longer act on it.
	w = httptest.NewRecorder()
	anonymous.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/articles/live", nil))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())

	// The bin lists it for its author.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/articles?trashed=true", nil))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"id":"live"`)
	require.Contains(t, w.Body.String(), `"deleted_at"`)

	// An anonymous caller gets the empty page a site with nothing trashed would
	// produce: a 403 here would confirm that the bin exists.
	w = httptest.NewRecorder()
	anonymous.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/articles?trashed=true", nil))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"items":[]`)

	// A malformed value is a 400, never a silently dropped filter.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/articles?trashed=maybe", nil))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())

	// undelete answers with the live view again.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/articles/live/undelete", nil))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), `"deleted_at"`)
	require.Contains(t, w.Body.String(), `"status":"published"`)
}

// TestPurgeActionReturnsNoContent pins the one destructive response: 204 with no body.
func TestPurgeActionReturnsNoContent(t *testing.T) {
	repo := liveItemRepo()
	r := trashEngine(t, repo, authorActor())

	// A live item is a state conflict, not a silent destruction.
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/articles/live/purge", nil))
	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/articles/live", nil))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/articles/live/purge", nil))
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
	require.Empty(t, w.Body.String())
	require.Empty(t, repo.items)
}

// TestDraftRequestCarriesSeoAndCoverFields checks the write path end to end: a valid
// PATCH persists the overrides, an unknown enum value is a field error.
func TestDraftRequestCarriesSeoAndCoverFields(t *testing.T) {
	repo := liveItemRepo()
	r := trashEngine(t, repo, authorActor())

	body := `{"title":"Live","source_body":"# body","seo_title":"SEO title",` +
		`"canonical_url":"https://example.test/c","robots":"noindex",` +
		`"cover_url":"https://example.test/cover.png","cover_alt":"alt",` +
		`"cover_position":"top","cover_hidden":true}`
	req := httptest.NewRequest(http.MethodPatch, "/articles/live", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"seo_title":"SEO title"`)
	require.Contains(t, w.Body.String(), `"robots":"noindex"`)
	require.Contains(t, w.Body.String(), `"cover_position":"top"`)
	require.Contains(t, w.Body.String(), `"cover_hidden":true`)

	bad := `{"title":"Live","source_body":"# body","cover_position":"middle"}`
	req = httptest.NewRequest(http.MethodPatch, "/articles/live", strings.NewReader(bad))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"cover_position"`)
}
