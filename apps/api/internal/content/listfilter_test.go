package content

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

func TestNormalizeTag(t *testing.T) {
	cases := map[string]string{
		"  Go  ":  "Go",
		"a":       "a",
		`bad"tag`: "",
		`bad\tag`: "",
		"":        "",
	}
	for in, want := range cases {
		if got := NormalizeTag(in); got != want {
			t.Fatalf("NormalizeTag(%q) = %q, want %q", in, got, want)
		}
	}
	long := make([]byte, 60)
	for i := range long {
		long[i] = 'a'
	}
	if got := NormalizeTag(string(long)); len(got) > 40 {
		t.Fatalf("NormalizeTag kept %d bytes, want <= 40", len(got))
	}
}

func TestListFilterSortValidation(t *testing.T) {
	if _, err := ValidateSort("newest"); err != nil {
		t.Fatalf("newest must be valid: %v", err)
	}
	if _, err := ValidateSort(""); err != nil {
		t.Fatalf("empty must default, not fail: %v", err)
	}
	if _, err := ValidateSort("popular"); err == nil {
		t.Fatal("unsupported sort must be rejected")
	}
	_ = time.Now()
}

// listQuery builds the gin context a listing request would produce.
func listQuery(t *testing.T, values url.Values) *gin.Context {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/articles?"+values.Encode(), nil)
	return c
}

// TestParseListFilterReadsEveryParameter pins the query contract of the listing
// endpoints: all five narrowing parameters are parsed, trimmed and normalised.
func TestParseListFilterReadsEveryParameter(t *testing.T) {
	filter, err := parseListFilter(listQuery(t, url.Values{
		"category_id": {"cat_a"},
		"tag":         {"  Go  "},
		"since":       {"2026-01-02T03:04:05Z"},
		"sort":        {"oldest"},
		"author_id":   {" alice "},
	}))
	require.NoError(t, err)

	require.Equal(t, "cat_a", filter.CategoryID)
	require.Equal(t, "Go", filter.Tag)
	require.Equal(t, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), filter.Since.UTC())
	require.Equal(t, SortOldest, filter.Sort)
	require.Equal(t, "alice", filter.AuthorID)
}

// TestParseListFilterDefaultsToNewest keeps an absent sort from becoming a
// validation error: the first page of a listing must not require any parameter.
func TestParseListFilterDefaultsToNewest(t *testing.T) {
	filter, err := parseListFilter(listQuery(t, url.Values{}))
	require.NoError(t, err)

	require.Equal(t, SortNewest, filter.Sort)
	require.True(t, filter.Since.IsZero(), "no since means unbounded")
	require.Empty(t, filter.Tag)
	require.Empty(t, filter.CategoryID)
	require.Empty(t, filter.AuthorID)
}

// TestParseListFilterRejectsMalformedValues collects the shapes a client must not
// smuggle into the store query, including the quote and backslash that would break
// the JSON token match.
func TestParseListFilterRejectsMalformedValues(t *testing.T) {
	cases := map[string]url.Values{
		"quote in tag":      {"tag": {`bad"tag`}},
		"backslash in tag":  {"tag": {`bad\tag`}},
		"overlong tag":      {"tag": {strings.Repeat("a", MaxTagFilterLength+1)}},
		"bad since":         {"since": {"not-a-time"}},
		"unknown sort":      {"sort": {"popular"}},
		"overlong category": {"category_id": {strings.Repeat("c", 37)}},
	}
	for name, values := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parseListFilter(listQuery(t, values))
			require.ErrorIs(t, err, ErrInvalidInput)
		})
	}
}

// TestListAfterFilterForwardsNarrowing pins both halves of the contract: the query
// filters reach the repository untouched, while the visibility fields the service
// owns are overwritten rather than taken from the caller.
func TestListAfterFilterForwardsNarrowing(t *testing.T) {
	repo := newFakeRepo()
	repo.items["pub"] = Content{ID: "pub", SiteID: "s1", AuthorID: "alice",
		Kind: KindArticle, Status: StatusPublished}
	repo.items["draft"] = Content{ID: "draft", SiteID: "s1", AuthorID: "alice",
		Kind: KindArticle, Status: StatusDraft}

	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	since := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	items, _, err := service.ListAfterFilter(
		context.Background(),
		actor("reader", site.RoleMember),
		KindArticle,
		10,
		page.Cursor{},
		ListFilter{
			AuthorID:   "alice",
			CategoryID: "cat_a",
			Tag:        "Go",
			Since:      since,
			Sort:       SortOldest,
			// A caller supplied status must be ignored: visibility is the service's.
			Statuses: []Status{StatusDraft},
		},
	)
	require.NoError(t, err)
	require.Len(t, items, 1, "a reader must not be able to widen the page to drafts")
	require.Equal(t, "pub", items[0].ID)

	require.Equal(t, "s1", repo.lastFilter.SiteID)
	require.Equal(t, KindArticle, repo.lastFilter.Kind)
	require.Equal(t, 10, repo.lastFilter.Limit)
	require.Equal(t, "alice", repo.lastFilter.AuthorID)
	require.Equal(t, "cat_a", repo.lastFilter.CategoryID)
	require.Equal(t, "Go", repo.lastFilter.Tag)
	require.True(t, since.Equal(repo.lastFilter.Since))
	require.Equal(t, SortOldest, repo.lastFilter.Sort)
	require.Equal(t, []Status{StatusPublished}, repo.lastFilter.Statuses)
}

// TestListAfterRejectsUnknownSort makes the service the last gate: no ordering name
// the store does not understand may reach the query builder.
func TestListAfterRejectsUnknownSort(t *testing.T) {
	service := newService(t, newFakeRepo(), okSanitizer(), site.PublishModeReview)

	_, _, err := service.ListAfterFilter(
		context.Background(),
		actor("mod", site.RoleEditor),
		KindArticle,
		10,
		page.Cursor{},
		ListFilter{Sort: "popular"},
	)
	require.ErrorIs(t, err, ErrInvalidInput)
}
