package contentstore_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/feed"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	"github.com/practacu/practacu-press/apps/api/internal/sitefiles"
)

// indexRows counts the full text rows of one item in both index flavours. A purge must
// clear both, otherwise a deleted body stays matchable after it was destroyed.
func (h *harness) indexRows(t *testing.T, contentID string) (base int, fts int) {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, h.db.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM content_search WHERE content_id = ?", contentID).Scan(&base))
	require.NoError(t, h.db.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM content_search_fts WHERE content_id = ?", contentID).Scan(&fts))
	return base, fts
}

// TestTrashHidesContentFromEverySurface is the SQLite smoke test for the recycle bin:
// one delete has to disappear from the detail read, the listing, search, the
// leaderboard, the history, the feed and the sitemap at once.
func TestTrashHidesContentFromEverySurface(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item := h.createPublished(t, draftInput())

	// Positive controls: every surface sees the item while it is live.
	found, err := h.service.Search(ctx, h.author(), content.SearchQuery{Term: "hello"})
	require.NoError(t, err)
	require.Len(t, found.Hits, 1)
	require.NoError(t, h.service.RecordView(ctx, content.ViewInput{
		SiteID: h.siteID, ContentID: item.ID, UserID: "reader",
	}))
	popular, err := h.service.Popular(ctx, h.author(), content.PopularQuery{})
	require.NoError(t, err)
	require.Len(t, popular, 1)

	trashed, err := h.service.Trash(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.NotNil(t, trashed.DeletedAt)

	_, err = h.service.Get(ctx, h.author(), item.ID)
	require.ErrorIs(t, err, content.ErrNotFound, "the detail read hides a trashed item")

	listed, err := h.service.List(ctx, h.author(), content.KindArticle, 10, content.ListFilter{})
	require.NoError(t, err)
	require.Empty(t, listed)

	found, err = h.service.Search(ctx, h.author(), content.SearchQuery{Term: "hello"})
	require.NoError(t, err)
	require.Empty(t, found.Hits, "search is excluded by the index predicate, not by a rebuild")
	require.Zero(t, found.Total)

	popular, err = h.service.Popular(ctx, h.author(), content.PopularQuery{})
	require.NoError(t, err)
	require.Empty(t, popular)

	_, err = h.service.ListRevisions(ctx, h.author(), item.ID)
	require.ErrorIs(t, err, content.ErrNotFound)

	channel, err := feed.Build(ctx, feed.Source{Content: h.service}, feed.Request{
		SiteID:   h.siteID,
		SiteName: "Main",
		Origin:   "https://example.test",
		FeedURL:  "https://example.test/rss.xml",
		Settings: feed.Defaults(),
	})
	require.NoError(t, err)
	require.Empty(t, channel.Items, "a trashed item is not in a feed")

	sitemapItems, err := sitefiles.Published(ctx, h.service, h.siteID)
	require.NoError(t, err)
	require.Empty(t, sitemapItems, "a trashed item is not in the sitemap")

	// The bin is the one surface that still returns it.
	bin, err := h.service.List(ctx, h.author(), content.KindArticle, 10, content.ListFilter{Trashed: true})
	require.NoError(t, err)
	require.Len(t, bin, 1)
	require.Equal(t, item.ID, bin[0].ID)
}

// TestUndeleteReturnsContentToEverySurface checks the other half of the soft delete:
// the index row is kept while the item sits in the bin, so a restore is immediate.
func TestUndeleteReturnsContentToEverySurface(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item := h.createPublished(t, draftInput())
	_, err := h.service.Trash(ctx, h.author(), item.ID)
	require.NoError(t, err)

	restored, err := h.service.Undelete(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.Nil(t, restored.DeletedAt)

	readable, err := h.service.Get(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.Equal(t, item.ID, readable.ID)

	found, err := h.service.Search(ctx, h.author(), content.SearchQuery{Term: "hello"})
	require.NoError(t, err)
	require.Len(t, found.Hits, 1)

	sitemapItems, err := sitefiles.Published(ctx, h.service, h.siteID)
	require.NoError(t, err)
	require.Len(t, sitemapItems, 1)
}

// TestPurgeRemovesRowHistoryAndIndexRows is the destruction contract: the row, its
// revisions and both index tables go, and nothing can be addressed any more.
func TestPurgeRemovesRowHistoryAndIndexRows(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item := h.createPublished(t, draftInput())
	revised := draftInput()
	revised.SourceBody = "# Revised"
	_, err := h.service.UpdateDraft(ctx, h.author(), item.ID, revised)
	require.NoError(t, err)

	base, fts := h.indexRows(t, item.ID)
	require.Equal(t, 1, base)
	require.Equal(t, 1, fts)

	// A live item cannot be destroyed in one step.
	require.ErrorIs(t, h.service.Purge(ctx, h.author(), item.ID), content.ErrInvalidTransition)

	_, err = h.service.Trash(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.NoError(t, h.service.Purge(ctx, h.author(), item.ID))

	exists, err := h.db.Client.ContentItem.Query().Exist(ctx)
	require.NoError(t, err)
	require.False(t, exists, "the row is gone")

	revisions, err := h.db.Client.ContentRevision.Query().Count(ctx)
	require.NoError(t, err)
	require.Zero(t, revisions, "the history goes with the item")

	base, fts = h.indexRows(t, item.ID)
	require.Zero(t, base, "the base index row is removed")
	require.Zero(t, fts, "the FTS row is removed")

	_, err = h.service.Get(ctx, h.author(), item.ID)
	require.ErrorIs(t, err, content.ErrNotFound)
}

// TestTrashRetentionSweepRemovesOnlyExpiredRows exercises ProcessTrashRetention against
// the real schema: the cutoff is the service clock, not a hard coded date.
func TestTrashRetentionSweepRemovesOnlyExpiredRows(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	old := h.createPublished(t, draftInput())
	_, err := h.service.Trash(ctx, h.author(), old.ID)
	require.NoError(t, err)

	// Move the clock past the retention window and trash a second item at that time.
	h.now = h.now.Add((content.TrashRetentionDays + 1) * 24 * time.Hour)
	recent := h.createPublished(t, draftInput())
	_, err = h.service.Trash(ctx, h.author(), recent.ID)
	require.NoError(t, err)
	// The first row was trashed at the old clock, so it is now older than the window.
	removed, err := h.service.ProcessTrashRetention(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, removed)

	bin, err := h.service.List(ctx, h.author(), content.KindArticle, 10, content.ListFilter{Trashed: true})
	require.NoError(t, err)
	require.Len(t, bin, 1)
	require.Equal(t, recent.ID, bin[0].ID)
}

// TestSchedulerSkipsTrashedDraft is the drain-the-bin safety property: a scheduled
// draft that the author deleted must not be published by the background publisher.
func TestSchedulerSkipsTrashedDraft(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	due := h.now.Add(30 * time.Minute)
	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, content.DraftInput{
		Title:        "Scheduled",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# Scheduled",
		PublishAt:    &due,
	})
	require.NoError(t, err)

	_, err = h.service.Trash(ctx, h.author(), item.ID)
	require.NoError(t, err)

	h.now = due.Add(time.Minute)
	result, err := h.service.ProcessScheduledPublishing(ctx)
	require.NoError(t, err)
	require.Zero(t, result.Due)
	require.Zero(t, result.Published)
}

// TestSeoAndCoverFieldsSurviveTheStore round trips the new columns through Ent, which
// is what catches a missing setter in the insert or update builder.
func TestSeoAndCoverFieldsSurviveTheStore(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	in := draftInput()
	in.SeoTitle = "SEO title"
	in.SeoDescription = "SEO description"
	in.SeoKeywords = "go, cms"
	in.CanonicalURL = "https://example.test/canonical"
	in.OgImage = "https://example.test/og.png"
	in.Robots = content.RobotsNoIndex
	in.CoverURL = "https://example.test/cover.png"
	in.CoverAlt = "cover alt"
	in.CoverPosition = content.CoverBottom
	in.CoverHidden = true

	item := h.createPublished(t, in)
	stored, err := h.service.Get(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.Equal(t, in.SeoTitle, stored.SeoTitle)
	require.Equal(t, in.SeoDescription, stored.SeoDescription)
	require.Equal(t, in.SeoKeywords, stored.SeoKeywords)
	require.Equal(t, in.CanonicalURL, stored.CanonicalURL)
	require.Equal(t, in.OgImage, stored.OgImage)
	require.Equal(t, content.RobotsNoIndex, stored.Robots)
	require.Equal(t, in.CoverURL, stored.CoverURL)
	require.Equal(t, in.CoverAlt, stored.CoverAlt)
	require.Equal(t, content.CoverBottom, stored.CoverPosition)
	require.True(t, stored.CoverHidden)

	// A noindex item stays readable but must not be advertised to crawlers.
	sitemapItems, err := sitefiles.Published(ctx, h.service, h.siteID)
	require.NoError(t, err)
	require.Empty(t, sitemapItems, "a noindex item is not a sitemap entry")
}

// TestTrashedRowsStillCountAgainstTheDraftQuota documents the deliberate exception to
// "reads exclude trashed rows": the quota bounds stored growth, so a trashed draft keeps
// counting until the retention sweep removes it.
func TestTrashedRowsStillCountAgainstTheDraftQuota(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, draftInput())
	require.NoError(t, err)
	_, err = h.service.Trash(ctx, h.author(), item.ID)
	require.NoError(t, err)

	store := contentstore.New(h.db.Client)
	count, err := store.CountActiveDraftsByAuthor(ctx, h.siteID, h.author().UserID)
	require.NoError(t, err)
	require.Equal(t, 1, count)
}
