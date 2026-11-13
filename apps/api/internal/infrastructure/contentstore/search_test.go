package contentstore_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// publishWithKind stores a draft as one actor and publishes it immediately. The
// harness runs with PublishModeOpen, so a member may publish directly.
func (h *harness) publishWithKind(
	t *testing.T,
	actor content.Actor,
	kind content.Kind,
	in content.DraftInput,
) content.Content {
	t.Helper()
	ctx := context.Background()

	item, err := h.service.CreateDraft(ctx, actor, kind, in)
	require.NoError(t, err)
	item, err = h.service.Apply(ctx, actor, item.ID, content.ActionPublish, "")
	require.NoError(t, err)
	require.Equal(t, content.StatusPublished, item.Status)
	return item
}

func hitIDs(result content.SearchResult) []string {
	ids := make([]string, 0, len(result.Hits))
	for _, hit := range result.Hits {
		ids = append(ids, hit.Content.ID)
	}
	return ids
}

func itemIDs(items []content.Content) []string {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	return ids
}

// TestSearchMatchesChineseAndLatinTokens is the SQLite smoke test for C-20: the
// index stores one token per CJK rune and one per Latin word, so a Chinese phrase
// and an English word both match without a per dialect query.
func TestSearchMatchesChineseAndLatinTokens(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()
	reader := content.Actor{SiteID: h.siteID}

	h.sanit.html = "<p>中文排版是一门手艺，讲字距与行距。</p>"
	cjk := h.createPublished(t, content.DraftInput{
		Title:        "中文排版的艺术",
		Summary:      "关于中文排版",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# 中文排版",
	})

	h.sanit.html = "<p>Typesetting notes about grids and rhythm.</p>"
	latin := h.createPublished(t, content.DraftInput{
		Title:        "Typesetting notes",
		Summary:      "about typesetting",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# Typesetting",
	})

	// A CJK run is a phrase: the runes must be adjacent and in order.
	found, err := h.service.Search(ctx, reader, content.SearchQuery{
		Term: "排版", Limit: 20, Highlight: true,
	})
	require.NoError(t, err)
	require.Equal(t, 1, found.Total)
	require.Equal(t, []string{cjk.ID}, hitIDs(found))
	require.False(t, found.Degraded, "SQLite provides real FTS5 relevance here")
	require.Contains(t, found.Hits[0].Snippet, "排版")
	require.NotContains(t, found.Hits[0].Snippet, "<", "a snippet is plain text, never markup")

	// The index stores lower case tokens, so the term's case does not matter.
	found, err = h.service.Search(ctx, reader, content.SearchQuery{Term: "TYPESETTING", Limit: 20})
	require.NoError(t, err)
	require.Equal(t, 1, found.Total)
	require.Equal(t, []string{latin.ID}, hitIDs(found))

	// A mixed term is one CJK phrase AND one Latin word, so it only matches the
	// item that carries both.
	h.sanit.html = "<p>排版 typesetting 手册</p>"
	mixed := h.createPublished(t, content.DraftInput{
		Title:        "排版 typesetting 手册",
		Summary:      "mixed languages",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# mixed",
	})
	found, err = h.service.Search(ctx, reader, content.SearchQuery{Term: "排版 typesetting", Limit: 20})
	require.NoError(t, err)
	require.Equal(t, 1, found.Total)
	require.Equal(t, []string{mixed.ID}, hitIDs(found))

	// A single CJK rune is below the minimum term length: the service refuses it
	// rather than turning a one character prefix into a match everything query.
	_, err = h.service.Search(ctx, reader, content.SearchQuery{Term: "排", Limit: 20})
	require.ErrorIs(t, err, content.ErrInvalidInput)
}

// TestSearchTreatsSpecialCharactersAsData proves the term is never spliced into
// SQL, FTS syntax or HTML: wildcards, quotes and markup are ordinary text.
func TestSearchTreatsSpecialCharactersAsData(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()
	reader := content.Actor{SiteID: h.siteID}

	h.sanit.html = "<p>100% cotton, hand bound, 100 sheets.</p>"
	item := h.createPublished(t, content.DraftInput{
		Title:        "100% cotton guide",
		Summary:      "how to bind",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# 100% cotton",
	})

	// `%` is a LIKE wildcard but a token separator in every index, so it cannot
	// widen the match to every row.
	found, err := h.service.Search(ctx, reader, content.SearchQuery{Term: "100%", Limit: 20, Highlight: true})
	require.NoError(t, err)
	require.Equal(t, 1, found.Total)
	require.Equal(t, []string{item.ID}, hitIDs(found))

	// Injection attempts are data. Each one must be a normal (possibly empty)
	// answer, and a returned snippet must still be plain text.
	terms := []string{
		`" OR 1=1 --`,
		`'; DROP TABLE content_search; --`,
		`* NEAR( hello`,
		`<script>alert(1)</script>`,
		`a"b\c`,
	}
	for _, term := range terms {
		result, err := h.service.Search(ctx, reader, content.SearchQuery{
			Term: term, Limit: 20, Highlight: true,
		})
		require.NoError(t, err, "term %q", term)
		for _, hit := range result.Hits {
			require.NotContains(t, hit.Snippet, "<", "term %q leaked markup", term)
		}
	}

	// A term with no searchable token is an empty page, not "match everything".
	for _, term := range []string{"!!!", "....", "  ,,  "} {
		result, err := h.service.Search(ctx, reader, content.SearchQuery{Term: term, Limit: 20})
		require.NoError(t, err, "term %q", term)
		require.Zero(t, result.Total, "term %q must not match", term)
		require.Empty(t, result.Hits)
	}

	// The stored markup never reaches the client as markup, and a script body is
	// not indexable text.
	h.sanit.html = "<p>hello <b>world</b> and <script>alert(1)</script> end</p>"
	h.createPublished(t, content.DraftInput{
		Title:        "Markup body",
		Summary:      "a body with tags",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# markup",
	})
	plain, err := h.service.Search(ctx, reader, content.SearchQuery{
		Term: "world", Limit: 20, Highlight: true,
	})
	require.NoError(t, err)
	require.Equal(t, 1, plain.Total)
	require.Contains(t, plain.Hits[0].Snippet, "world")
	require.NotContains(t, plain.Hits[0].Snippet, "<b>")

	scripts, err := h.service.Search(ctx, reader, content.SearchQuery{Term: "alert", Limit: 20})
	require.NoError(t, err)
	require.Zero(t, scripts.Total, "script bodies are not indexed text")
}

// TestSearchPaginationIsStable walks the real cursor until exhaustion and proves
// every item is returned exactly once, with a decodable opaque boundary.
func TestSearchPaginationIsStable(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()
	reader := content.Actor{SiteID: h.siteID}

	h.sanit.html = "<p>shared body about pagination</p>"
	created := make([]string, 0, 5)
	for i := 0; i < 5; i++ {
		item := h.createPublished(t, content.DraftInput{
			Title:        fmt.Sprintf("Pagination chapter %d", i),
			Summary:      "shared summary about pagination",
			SourceFormat: content.FormatMarkdown,
			SourceBody:   "# pagination",
		})
		created = append(created, item.ID)
	}

	seen := make(map[string]struct{}, len(created))
	cursor := page.Cursor{}
	pages := 0
	for {
		result, err := h.service.Search(ctx, reader, content.SearchQuery{
			Term: "pagination", Limit: 2, After: cursor,
		})
		require.NoError(t, err)
		require.Equal(t, len(created), result.Total, "total counts every page")
		require.LessOrEqual(t, len(result.Hits), 2)
		pages++

		for _, id := range hitIDs(result) {
			_, repeat := seen[id]
			require.False(t, repeat, "a page boundary repeated an item")
			seen[id] = struct{}{}
		}
		if result.NextCursor == "" {
			break
		}
		decoded, err := page.Decode(result.NextCursor)
		require.NoError(t, err, "next_cursor must be an opaque token the server can decode")
		require.True(t, strings.HasPrefix(decoded.Key, "s:"),
			"an indexed page carries the score boundary")
		require.NotEmpty(t, decoded.ID, "the id is the tie breaker for equal scores")
		cursor = decoded
		require.Less(t, pages, 10, "pagination must terminate")
	}
	require.Equal(t, 3, pages, "5 items at 2 per page")
	require.Len(t, seen, len(created))
	for _, id := range created {
		require.Contains(t, seen, id)
	}

	// A boundary minted by a different mode is refused, never misapplied.
	_, err := h.service.Search(ctx, reader, content.SearchQuery{
		Term:  "pagination",
		Limit: 2,
		After: page.Cursor{Key: "t:2026-01-01T00:00:00Z", ID: "content_x"},
	})
	require.ErrorIs(t, err, page.ErrInvalidCursor)
}

// TestSearchFiltersNarrowThePage covers kind, category, tag, author and the time
// range: each filter must narrow, and a tag with a LIKE wildcard must not widen.
func TestSearchFiltersNarrowThePage(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()
	reader := content.Actor{SiteID: h.siteID}

	first := time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC)
	h.now = first
	h.sanit.html = "<p>filter body with the shared word</p>"
	article := h.createPublished(t, content.DraftInput{
		Title:        "Shared word article",
		Summary:      "filter summary",
		CategoryID:   "cat_a",
		Tags:         []string{"排版", "press"},
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# shared",
	})

	h.now = first.Add(48 * time.Hour)
	h.sanit.html = "<p>filter body with the shared word</p>"
	post := h.publishWithKind(t, content.Actor{
		UserID: "author_2", SiteID: h.siteID, Role: site.RoleMember,
	}, content.KindPost, content.DraftInput{
		Title:        "Shared word post",
		Summary:      "another filter summary",
		CategoryID:   "cat_b",
		Tags:         []string{"press"},
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# shared",
	})

	search := func(query content.SearchQuery) content.SearchResult {
		query.Term = "shared"
		query.Limit = 20
		result, err := h.service.Search(ctx, reader, query)
		require.NoError(t, err)
		return result
	}

	require.ElementsMatch(t, []string{article.ID, post.ID}, hitIDs(search(content.SearchQuery{})))
	require.Equal(t, []string{article.ID}, hitIDs(search(content.SearchQuery{Kind: content.KindArticle})))
	require.Equal(t, []string{post.ID}, hitIDs(search(content.SearchQuery{Kind: content.KindPost})))
	require.Equal(t, []string{article.ID}, hitIDs(search(content.SearchQuery{CategoryID: "cat_a"})))
	require.Equal(t, []string{article.ID}, hitIDs(search(content.SearchQuery{Tag: "排版"})))
	require.ElementsMatch(t, []string{article.ID, post.ID}, hitIDs(search(content.SearchQuery{Tag: "press"})))
	require.Equal(t, []string{post.ID}, hitIDs(search(content.SearchQuery{AuthorID: "author_2"})))

	// The tag filter compares the quoted JSON token, so a wildcard inside the tag
	// is escaped instead of matching everything.
	require.Empty(t, hitIDs(search(content.SearchQuery{Tag: "排%"})))
	require.Empty(t, hitIDs(search(content.SearchQuery{Tag: "sha_ed"})))

	// The creation time range is inclusive at both ends and narrows per item.
	require.ElementsMatch(t, []string{article.ID, post.ID},
		hitIDs(search(content.SearchQuery{Since: first})))
	require.Equal(t, []string{post.ID},
		hitIDs(search(content.SearchQuery{Since: first.Add(24 * time.Hour)})))
	require.Equal(t, []string{article.ID},
		hitIDs(search(content.SearchQuery{Until: first.Add(24 * time.Hour)})))

	// Filters combine with AND, not OR.
	require.Equal(t, []string{article.ID}, hitIDs(search(content.SearchQuery{
		Kind: content.KindArticle, Tag: "press", CategoryID: "cat_a",
	})))
	require.Empty(t, hitIDs(search(content.SearchQuery{
		Kind: content.KindArticle, AuthorID: "author_2",
	})))
}

// TestSearchIndexFollowsContentWrites keeps the derived index honest: a draft is
// invisible, publishing exposes the current title, and archiving withdraws it.
func TestSearchIndexFollowsContentWrites(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()
	reader := content.Actor{SiteID: h.siteID}

	h.sanit.html = "<p>quiet print run</p>"
	draft, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, content.DraftInput{
		Title:        "Quiet printing notes",
		Summary:      "a first draft",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# quiet",
	})
	require.NoError(t, err)

	// A draft is written to the index by the create path but must never surface.
	found, err := h.service.Search(ctx, reader, content.SearchQuery{Term: "printing", Limit: 20})
	require.NoError(t, err)
	require.Zero(t, found.Total, "a draft is not searchable")

	// Renaming while still a draft keeps the index in step with the row. The
	// sanitizer stand-in renders the new body too, so the old body text really is
	// gone from the stored item.
	h.sanit.html = "<p>loud print run</p>"
	_, err = h.service.UpdateDraft(ctx, h.author(), draft.ID, content.DraftInput{
		Title:        "Loud printing proofs",
		Summary:      "a renamed draft",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# loud",
	})
	require.NoError(t, err)

	_, err = h.service.Apply(ctx, h.author(), draft.ID, content.ActionPublish, "")
	require.NoError(t, err)

	found, err = h.service.Search(ctx, reader, content.SearchQuery{Term: "loud", Limit: 20})
	require.NoError(t, err)
	require.Equal(t, []string{draft.ID}, hitIDs(found))
	require.Equal(t, 1, found.Total)

	// The old title is gone from the index, not merely hidden by the status gate.
	found, err = h.service.Search(ctx, reader, content.SearchQuery{Term: "quiet", Limit: 20})
	require.NoError(t, err)
	require.Zero(t, found.Total)

	_, err = h.service.Apply(ctx, h.author(), draft.ID, content.ActionArchive, "")
	require.NoError(t, err)

	found, err = h.service.Search(ctx, reader, content.SearchQuery{Term: "loud", Limit: 20})
	require.NoError(t, err)
	require.Zero(t, found.Total, "an archived item leaves the searchable set")
}

// TestSearchFallsBackToLikeWithoutIndexHandle is the documented degradation: a
// store that cannot reach the index answers from the LIKE path and says so.
func TestSearchFallsBackToLikeWithoutIndexHandle(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	h.sanit.html = "<p>fallback body text</p>"
	item := h.createPublished(t, content.DraftInput{
		Title:        "Fallback article",
		Summary:      "no index here",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# fallback",
	})
	second := h.createPublished(t, content.DraftInput{
		Title:        "Fallback afterthought",
		Summary:      "also no index",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# second",
	})

	// No raw handle: the index cannot be created or queried at all.
	store := contentstore.New(h.db.Client)

	status, err := store.SearchIndexStatus(ctx)
	require.NoError(t, err)
	require.False(t, status.Available)
	require.NotEmpty(t, status.LastError, "the diagnostics report why the index is unavailable")
	require.Error(t, store.EnsureSearchIndex(ctx))

	result, err := store.Search(ctx, content.SearchFilter{
		SiteID: h.siteID, Term: "fallback", Limit: 20,
	})
	require.NoError(t, err)
	require.True(t, result.Degraded, "the LIKE fallback reports the missing relevance order")
	require.Equal(t, 2, result.Total)
	require.ElementsMatch(t, []string{item.ID, second.ID}, itemIDs(result.Items))

	// The fallback pages by creation time and still mints an opaque cursor.
	firstPage, err := store.Search(ctx, content.SearchFilter{
		SiteID: h.siteID, Term: "fallback", Limit: 1,
	})
	require.NoError(t, err)
	require.Len(t, firstPage.Items, 1)
	require.NotEmpty(t, firstPage.NextCursor)
	decoded, err := page.Decode(firstPage.NextCursor)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(decoded.Key, "t:"),
		"a LIKE page carries its own boundary prefix")

	secondPage, err := store.Search(ctx, content.SearchFilter{
		SiteID: h.siteID, Term: "fallback", Limit: 1, After: decoded,
	})
	require.NoError(t, err)
	require.Len(t, secondPage.Items, 1)
	require.NotEqual(t, firstPage.Items[0].ID, secondPage.Items[0].ID)
	require.Empty(t, secondPage.NextCursor)
}

// TestSearchIgnoresIndexRowsWhoseItemWasRemoved covers the delete half of "the
// index follows the content": the row is derived, so a content item removed out
// of band must not surface, and must not be counted, before the next rebuild.
func TestSearchIgnoresIndexRowsWhoseItemWasRemoved(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()
	reader := content.Actor{SiteID: h.siteID}

	h.sanit.html = "<p>orphan body</p>"
	item := h.createPublished(t, content.DraftInput{
		Title:        "Orphan article",
		Summary:      "an item that will be removed",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# orphan",
	})

	found, err := h.service.Search(ctx, reader, content.SearchQuery{Term: "orphan", Limit: 20})
	require.NoError(t, err)
	require.Equal(t, 1, found.Total)

	// Remove the content row directly, the way a manual repair or a deleted
	// account would. The derived index row stays behind until the next rebuild.
	require.NoError(t, h.db.Client.ContentItem.DeleteOneID(item.ID).Exec(ctx))

	var remaining int
	require.NoError(t, h.db.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM content_search WHERE content_id = ?", item.ID).Scan(&remaining))
	require.Equal(t, 1, remaining, "the index row outlives the content row")

	orphaned, err := h.service.Search(ctx, reader, content.SearchQuery{Term: "orphan", Limit: 20})
	require.NoError(t, err)
	require.Empty(t, orphaned.Hits, "an orphan index row is never returned")
	require.Zero(t, orphaned.Total, "and it is not counted either")
}

// TestRebuildSearchIndexBackfillsExistingRows covers the repair path an operator
// runs after the migration: the index is derived data and can be rebuilt.
func TestRebuildSearchIndexBackfillsExistingRows(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	h.sanit.html = "<p>rebuildable body</p>"
	item := h.createPublished(t, content.DraftInput{
		Title:        "Rebuildable article",
		Summary:      "needs a backfill",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# rebuild",
	})

	// Simulate an index that was lost or never backfilled.
	_, err := h.db.SQL().ExecContext(ctx, "DELETE FROM content_search_fts")
	require.NoError(t, err)
	_, err = h.db.SQL().ExecContext(ctx, "DELETE FROM content_search")
	require.NoError(t, err)

	store := contentstore.New(h.db.Client, h.db)
	status, err := store.SearchIndexStatus(ctx)
	require.NoError(t, err)
	require.True(t, status.Available)
	require.Zero(t, status.Indexed)
	require.Equal(t, 1, status.Missing, "the published row is missing from the index")

	empty, err := store.Search(ctx, content.SearchFilter{
		SiteID: h.siteID, Term: "rebuildable", Limit: 20,
	})
	require.NoError(t, err)
	require.Zero(t, empty.Total)

	rebuilt, err := store.RebuildSearchIndex(ctx)
	require.NoError(t, err)
	require.Zero(t, rebuilt.Missing)
	require.Equal(t, 1, rebuilt.Indexed)

	found, err := store.Search(ctx, content.SearchFilter{
		SiteID: h.siteID, Term: "rebuildable", Limit: 20,
	})
	require.NoError(t, err)
	require.Equal(t, 1, found.Total)
	require.Equal(t, item.ID, found.Items[0].ID)
}
