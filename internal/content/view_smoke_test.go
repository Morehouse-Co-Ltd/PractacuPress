package content_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"

	entgen "github.com/practacu/practacu-press/internal/ent"
)

// viewSmoke is the end-to-end check of the read counter and the leaderboard: a real
// SQLite database, the real store and the real HTTP handler, so the de-duplication,
// the list projection and the popular ordering are exercised the way a reader hits
// them.
type viewSmoke struct {
	engine *gin.Engine
	client *entgen.Client
	siteID string
}

func newViewSmoke(t *testing.T) *viewSmoke {
	t.Helper()
	ctx := context.Background()
	gin.SetMode(gin.TestMode)

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "views.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	store := contentstore.New(handle.Client, handle)
	service, err := content.NewService(content.ServiceConfig{
		Repository: store,
		Sanitizer:  acceptingSanitizer{},
		PublishMode: func(context.Context, string) (site.PublishMode, error) {
			return site.PublishModeOpen, nil
		},
		Now: func() time.Time { return time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)

	resolved := site.Site{ID: siteRow.ID, Slug: "main", VisibilityMode: site.VisibilityPublic}
	handler := content.NewHandler(service, content.HandlerConfig{
		// The header stands in for a signed in reader, so the author's own read can be
		// checked as a self view without minting a token.
		Principal: func(c *gin.Context) (content.Actor, bool) {
			userID := c.GetHeader("X-Test-User")
			if userID == "" {
				return content.Actor{}, false
			}
			return content.Actor{UserID: userID, SiteID: siteRow.ID, Role: site.RoleMember}, true
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

	return &viewSmoke{engine: r, client: handle.Client, siteID: siteRow.ID}
}

// seed inserts one published article with an explicit read counter and access mode.
func (s *viewSmoke) seed(t *testing.T, id string, views int, categoryID string, tags []string, access content.AccessMode) {
	t.Helper()
	at := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)
	if access == "" {
		access = content.AccessPublic
	}
	create := s.client.ContentItem.Create().
		SetID(id).
		SetSiteID(s.siteID).
		SetAuthorID("author_1").
		SetKind(string(content.KindArticle)).
		SetStatus(string(content.StatusPublished)).
		SetTitle(id).
		SetSourceBody("body").
		SetRenderedHTML("<p>body</p>").
		SetPolicyVersion("p1").
		SetAccessMode(string(access)).
		SetViewCount(views).
		SetPublishedAt(at).
		SetCreatedAt(at).
		SetUpdatedAt(at).
		SetTags(content.EncodeTags(tags))
	if categoryID != "" {
		create = create.SetCategoryID(categoryID)
	}
	_, err := create.Save(context.Background())
	require.NoError(t, err)
}

// storedViews reads the counter straight from the database, so an assertion cannot be
// satisfied by a response that merely echoes the request.
func (s *viewSmoke) storedViews(t *testing.T, id string) int {
	t.Helper()
	row, err := s.client.ContentItem.Get(context.Background(), id)
	require.NoError(t, err)
	return row.ViewCount
}

// do performs one request and returns the recorder.
func (s *viewSmoke) do(t *testing.T, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	s.engine.ServeHTTP(recorder, request)
	return recorder
}

type viewSmokeItem struct {
	ID        string `json:"id"`
	ViewCount int    `json:"view_count"`
}

type viewSmokePopular struct {
	Items  []viewSmokeItem `json:"items"`
	Window string          `json:"window"`
}

type viewSmokePage struct {
	Items []viewSmokeItem `json:"items"`
}

// TestReadCountingAndPopularEndToEnd is the acceptance smoke test of this feature:
// read N times, watch the de-duplication hold, then read the counter back through the
// detail, the list and the leaderboard, including a category filter.
func TestReadCountingAndPopularEndToEnd(t *testing.T) {
	smoke := newViewSmoke(t)
	smoke.seed(t, "a", 0, "cat_a", []string{"Go"}, content.AccessPublic)
	smoke.seed(t, "b", 0, "cat_b", nil, content.AccessPublic)
	// A direct-link-only item must never reach the leaderboard, however popular.
	smoke.seed(t, "locked", 500, "cat_a", nil, content.AccessPassword)

	session := map[string]string{"X-Visit-Session": "vs_smoke_1"}

	// 1) One read: the response carries the count *before* this read, the stored
	// counter is 1.
	first := smoke.do(t, "/articles/a", session)
	require.Equal(t, http.StatusOK, first.Code, first.Body.String())
	var detail viewSmokeItem
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &detail))
	require.Equal(t, "a", detail.ID)
	require.Zero(t, detail.ViewCount, "the served page shows the count before this read")
	require.Equal(t, 1, smoke.storedViews(t, "a"))

	// 2) The same session reading again is the same read.
	require.Equal(t, http.StatusOK, smoke.do(t, "/articles/a", session).Code)
	require.Equal(t, 1, smoke.storedViews(t, "a"))

	// 3) Two more sessions, and a signed in reader who is not the author.
	require.Equal(t, http.StatusOK, smoke.do(t, "/articles/a", map[string]string{"X-Visit-Session": "vs_smoke_2"}).Code)
	require.Equal(t, http.StatusOK, smoke.do(t, "/articles/a", map[string]string{"X-Test-User": "reader_9"}).Code)
	require.Equal(t, 3, smoke.storedViews(t, "a"))

	// 4) The author's own read is not counted.
	require.Equal(t, http.StatusOK, smoke.do(t, "/articles/a", map[string]string{"X-Test-User": "author_1"}).Code)
	require.Equal(t, 3, smoke.storedViews(t, "a"))

	// 5) The other item gets a different number of reads so the leaderboard has an
	// unambiguous order.
	for _, reader := range []string{"vs_b_1", "vs_b_2", "vs_b_3", "vs_b_4"} {
		require.Equal(t, http.StatusOK, smoke.do(t, "/articles/b", map[string]string{"X-Visit-Session": reader}).Code)
	}
	require.Equal(t, 4, smoke.storedViews(t, "b"))

	// 6) The detail and the list both expose the counter.
	listed := smoke.do(t, "/articles?limit=10", nil)
	require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
	var page viewSmokePage
	require.NoError(t, json.Unmarshal(listed.Body.Bytes(), &page))
	counts := make(map[string]int, len(page.Items))
	for _, item := range page.Items {
		counts[item.ID] = item.ViewCount
	}
	require.Equal(t, 3, counts["a"])
	require.Equal(t, 4, counts["b"])

	// 7) The leaderboard is ordered by the decayed score; with one shared publication
	// instant that is the read count.
	popular := smoke.do(t, "/content/popular?limit=5", nil)
	require.Equal(t, http.StatusOK, popular.Code, popular.Body.String())
	var board viewSmokePopular
	require.NoError(t, json.Unmarshal(popular.Body.Bytes(), &board))
	require.Equal(t, "30d", board.Window)
	require.Equal(t, []string{"b", "a"}, idsOf(board.Items))
	require.Equal(t, 4, board.Items[0].ViewCount)
	require.NotContains(t, idsOf(board.Items), "locked")

	// 8) The category filter narrows the same board.
	narrowed := smoke.do(t, "/content/popular?category_id=cat_a&limit=5", nil)
	require.Equal(t, http.StatusOK, narrowed.Code, narrowed.Body.String())
	var filtered viewSmokePopular
	require.NoError(t, json.Unmarshal(narrowed.Body.Bytes(), &filtered))
	require.Equal(t, []string{"a"}, idsOf(filtered.Items))

	// 9) A bad window is refused instead of silently falling back.
	require.Equal(t, http.StatusBadRequest, smoke.do(t, "/content/popular?window=1y", nil).Code)
}

func idsOf(items []viewSmokeItem) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.ID)
	}
	return out
}
