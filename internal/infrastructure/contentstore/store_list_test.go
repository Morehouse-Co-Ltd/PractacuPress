package contentstore_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
)

// seedBase is a whole second on purpose: the cursor round trip in these tests formats
// the stored instant back into RFC 3339, so a sub second value would only test the
// database's timestamp precision rather than the ordering logic.
var seedBase = time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)

// seed inserts one published row with an explicit creation time. It bypasses the
// service because created_at is only ever "now" there, and these tests need to
// control the ordering the filter is supposed to produce.
func (h *harness) seed(t *testing.T, id string, createdAt time.Time, categoryID string, tags []string) {
	t.Helper()

	create := h.db.Client.ContentItem.Create().
		SetID(id).
		SetSiteID(h.siteID).
		SetAuthorID("author_1").
		SetKind(string(content.KindArticle)).
		SetStatus(string(content.StatusPublished)).
		SetTitle(id).
		SetSourceBody("body").
		SetCreatedAt(createdAt).
		SetUpdatedAt(createdAt).
		SetTags(content.EncodeTags(tags))
	if categoryID != "" {
		create = create.SetCategoryID(categoryID)
	}
	_, err := create.Save(context.Background())
	require.NoError(t, err)
}

func ids(items []content.Content) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.ID)
	}
	return out
}

func TestListFiltersByCategory(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	h.seed(t, "in-cat", seedBase, "cat_a", nil)
	h.seed(t, "other-cat", seedBase.Add(time.Hour), "cat_b", nil)

	store := contentstore.New(h.db.Client)
	items, err := store.List(context.Background(), content.ListFilter{
		SiteID: h.siteID, Limit: 10, CategoryID: "cat_a",
	})
	require.NoError(t, err)
	require.Equal(t, []string{"in-cat"}, ids(items))

	// An unknown category is an empty page, not an error: the id is a filter value,
	// not a resource the listing can validate.
	empty, err := store.List(context.Background(), content.ListFilter{
		SiteID: h.siteID, Limit: 10, CategoryID: "ghost",
	})
	require.NoError(t, err)
	require.Empty(t, empty)
}

// TestListMatchesTagAsExactToken is the portability guard for the tag filter: the
// column holds a JSON array of names, so only a quoted token match may match, never a
// bare substring like "Go" inside "GoLang" or "We" inside "Web".
func TestListMatchesTagAsExactToken(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	h.seed(t, "exact", seedBase, "", []string{"Go", "Web"})
	h.seed(t, "longer", seedBase, "", []string{"GoLang"})
	h.seed(t, "web-only", seedBase, "", []string{"Web"})
	h.seed(t, "untagged", seedBase, "", nil)

	store := contentstore.New(h.db.Client)

	items, err := store.List(context.Background(), content.ListFilter{
		SiteID: h.siteID, Limit: 10, Tag: "Go",
	})
	require.NoError(t, err)
	require.Equal(t, []string{"exact"}, ids(items))

	partial, err := store.List(context.Background(), content.ListFilter{
		SiteID: h.siteID, Limit: 10, Tag: "We",
	})
	require.NoError(t, err)
	require.Empty(t, partial, `"Web" must not be found by the prefix "We"`)
}

func TestListFiltersBySince(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	h.seed(t, "old", seedBase, "", nil)
	h.seed(t, "middle", seedBase.Add(time.Hour), "", nil)
	h.seed(t, "new", seedBase.Add(2*time.Hour), "", nil)

	store := contentstore.New(h.db.Client)
	items, err := store.List(context.Background(), content.ListFilter{
		SiteID: h.siteID, Limit: 10, Since: seedBase.Add(time.Hour),
	})
	require.NoError(t, err)
	require.Equal(t, []string{"new", "middle"}, ids(items), "since is inclusive and newest is first")
}

func TestListSortOrdersBothWays(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	h.seed(t, "a", seedBase, "", nil)
	h.seed(t, "b", seedBase.Add(time.Hour), "", nil)
	h.seed(t, "c", seedBase.Add(2*time.Hour), "", nil)

	store := contentstore.New(h.db.Client)
	ctx := context.Background()

	newest, err := store.List(ctx, content.ListFilter{SiteID: h.siteID, Limit: 10})
	require.NoError(t, err)
	require.Equal(t, []string{"c", "b", "a"}, ids(newest), "the default ordering is newest first")

	oldest, err := store.List(ctx, content.ListFilter{
		SiteID: h.siteID, Limit: 10, Sort: content.SortOldest,
	})
	require.NoError(t, err)
	require.Equal(t, []string{"a", "b", "c"}, ids(oldest))
}

// TestListOldestAdvancesCursorForwards keeps pagination coherent with the ordering:
// under "oldest" the next page starts after the last item shown, not before it.
func TestListOldestAdvancesCursorForwards(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	h.seed(t, "a", seedBase, "", nil)
	h.seed(t, "b", seedBase.Add(time.Hour), "", nil)
	h.seed(t, "c", seedBase.Add(2*time.Hour), "", nil)

	store := contentstore.New(h.db.Client)
	ctx := context.Background()

	first, err := store.List(ctx, content.ListFilter{
		SiteID: h.siteID, Limit: 2, Sort: content.SortOldest,
	})
	require.NoError(t, err)
	require.Equal(t, []string{"a", "b"}, ids(first))

	// The service derives the cursor from the last item of the page, so the test does
	// the same instead of inventing an instant.
	last, err := h.db.Client.ContentItem.Get(ctx, "b")
	require.NoError(t, err)

	second, err := store.List(ctx, content.ListFilter{
		SiteID: h.siteID,
		Limit:  2,
		Sort:   content.SortOldest,
		After: page.Cursor{
			Key: last.CreatedAt.UTC().Format(time.RFC3339Nano),
			ID:  last.ID,
		},
	})
	require.NoError(t, err)
	require.Equal(t, []string{"c"}, ids(second))
}
