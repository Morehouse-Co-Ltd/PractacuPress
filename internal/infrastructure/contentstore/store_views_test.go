package contentstore_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/internal/site"
)

// seedReadable inserts one published row with an explicit read counter, publication
// instant and narrowing values. It bypasses the service because both the counter and
// the publication date are only ever "now" or zero there, and these tests need to
// control what the leaderboard orders.
type readableSeed struct {
	id          string
	views       int
	publishedAt time.Time
	kind        content.Kind
	categoryID  string
	tags        []string
	accessMode  content.AccessMode
	status      content.Status
}

func (h *harness) seedReadable(t *testing.T, seed readableSeed) {
	t.Helper()

	if seed.kind == "" {
		seed.kind = content.KindArticle
	}
	if seed.accessMode == "" {
		seed.accessMode = content.AccessPublic
	}
	if seed.status == "" {
		seed.status = content.StatusPublished
	}

	published := seed.publishedAt
	create := h.db.Client.ContentItem.Create().
		SetID(seed.id).
		SetSiteID(h.siteID).
		SetAuthorID("author_1").
		SetKind(string(seed.kind)).
		SetStatus(string(seed.status)).
		SetTitle(seed.id).
		SetSourceBody("body").
		SetViewCount(seed.views).
		SetPublishedAt(published).
		SetCreatedAt(published).
		SetUpdatedAt(published).
		SetAccessMode(string(seed.accessMode)).
		SetTags(content.EncodeTags(seed.tags))
	if seed.categoryID != "" {
		create = create.SetCategoryID(seed.categoryID)
	}
	_, err := create.Save(context.Background())
	require.NoError(t, err)
}

// TestIncrementViewCountOnlyCountsPublishedRows is the write contract: one increment
// per call, only for a published row of the same site.
func TestIncrementViewCountOnlyCountsPublishedRows(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	h.seedReadable(t, readableSeed{id: "live", views: 2, publishedAt: seedBase})
	h.seedReadable(t, readableSeed{id: "hidden", status: content.StatusDraft, publishedAt: seedBase})

	store := contentstore.New(h.db.Client)
	ctx := context.Background()

	require.NoError(t, store.IncrementViewCount(ctx, h.siteID, "live"))
	require.NoError(t, store.IncrementViewCount(ctx, h.siteID, "live"))
	// A draft, another site and an unknown id are all no-ops rather than errors: the
	// counter is best effort and must never fail a read.
	require.NoError(t, store.IncrementViewCount(ctx, h.siteID, "hidden"))
	require.NoError(t, store.IncrementViewCount(ctx, "other-site", "live"))
	require.NoError(t, store.IncrementViewCount(ctx, h.siteID, "ghost"))

	row, err := store.FindByID(ctx, h.siteID, "live")
	require.NoError(t, err)
	require.Equal(t, 4, row.ViewCount)

	draft, err := store.FindByID(ctx, h.siteID, "hidden")
	require.NoError(t, err)
	require.Zero(t, draft.ViewCount)
}

// TestPopularOrdersByViewsThenPublication pins the candidate ordering the service
// re-ranks: raw reads first, then the newer item, then the id.
func TestPopularOrdersByViewsThenPublication(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	h.seedReadable(t, readableSeed{id: "low", views: 1, publishedAt: seedBase.Add(2 * time.Hour)})
	h.seedReadable(t, readableSeed{id: "high", views: 9, publishedAt: seedBase})
	h.seedReadable(t, readableSeed{id: "high-newer", views: 9, publishedAt: seedBase.Add(time.Hour)})

	store := contentstore.New(h.db.Client)
	items, err := store.Popular(context.Background(), content.PopularFilter{
		SiteID:         h.siteID,
		PublishedSince: seedBase.Add(-time.Hour),
		Limit:          10,
	})
	require.NoError(t, err)
	require.Equal(t, []string{"high-newer", "high", "low"}, ids(items))
	require.Equal(t, 9, items[0].ViewCount, "the row projection must carry the counter")
}

// TestPopularFiltersByKindCategoryTag keeps the leaderboard filters exact.
func TestPopularFiltersByKindCategoryTag(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	h.seedReadable(t, readableSeed{id: "match", views: 5, publishedAt: seedBase, kind: content.KindPost, categoryID: "cat_a", tags: []string{"Go"}})
	h.seedReadable(t, readableSeed{id: "other-kind", views: 8, publishedAt: seedBase, kind: content.KindArticle, categoryID: "cat_a", tags: []string{"Go"}})
	h.seedReadable(t, readableSeed{id: "other-tag", views: 8, publishedAt: seedBase, kind: content.KindPost, categoryID: "cat_a", tags: []string{"GoLang"}})
	h.seedReadable(t, readableSeed{id: "other-cat", views: 8, publishedAt: seedBase, kind: content.KindPost, categoryID: "cat_b", tags: []string{"Go"}})

	store := contentstore.New(h.db.Client)
	items, err := store.Popular(context.Background(), content.PopularFilter{
		SiteID:     h.siteID,
		Kind:       content.KindPost,
		CategoryID: "cat_a",
		Tag:        "Go",
		Limit:      10,
	})
	require.NoError(t, err)
	require.Equal(t, []string{"match"}, ids(items))
}

// TestPopularExcludesDirectLinkOnlyAndOldItems is the visibility guard: a password or
// members-only item, a draft and an item published outside the window never compete.
func TestPopularExcludesDirectLinkOnlyAndOldItems(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	h.seedReadable(t, readableSeed{id: "public", views: 1, publishedAt: seedBase})
	h.seedReadable(t, readableSeed{id: "password", views: 99, publishedAt: seedBase, accessMode: content.AccessPassword})
	h.seedReadable(t, readableSeed{id: "members", views: 99, publishedAt: seedBase, accessMode: content.AccessMembers})
	h.seedReadable(t, readableSeed{id: "draft", views: 99, publishedAt: seedBase, status: content.StatusDraft})
	h.seedReadable(t, readableSeed{id: "archived", views: 99, publishedAt: seedBase, status: content.StatusArchived})

	store := contentstore.New(h.db.Client)
	items, err := store.Popular(context.Background(), content.PopularFilter{
		SiteID:         h.siteID,
		PublishedSince: seedBase.Add(-24 * time.Hour),
		Limit:          10,
	})
	require.NoError(t, err)
	require.Equal(t, []string{"public"}, ids(items))

	// A later window start drops everything: the date bound is inclusive on the
	// stored instant and the row is outside it.
	empty, err := store.Popular(context.Background(), content.PopularFilter{
		SiteID:         h.siteID,
		PublishedSince: seedBase.Add(time.Minute),
		Limit:          10,
	})
	require.NoError(t, err)
	require.Empty(t, empty)
}

// TestEditingPublishedContentKeepsItsReadCount is the regression that matters most: a
// save rewrites every author editable column, so it must not zero the counter.
func TestEditingPublishedContentKeepsItsReadCount(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	draft, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, draftInput())
	require.NoError(t, err)
	published, err := h.service.Apply(ctx, h.author(), draft.ID, content.ActionPublish, "")
	require.NoError(t, err)
	require.Equal(t, content.StatusPublished, published.Status)

	store := contentstore.New(h.db.Client)
	require.NoError(t, store.IncrementViewCount(ctx, h.siteID, draft.ID))
	require.NoError(t, store.IncrementViewCount(ctx, h.siteID, draft.ID))

	edited := draftInput()
	edited.Title = "Renamed after two reads"
	updated, err := h.service.UpdateDraft(ctx, h.author(), draft.ID, edited)
	require.NoError(t, err)
	require.Equal(t, 2, updated.ViewCount)

	stored, err := store.FindByID(ctx, h.siteID, draft.ID)
	require.NoError(t, err)
	require.Equal(t, 2, stored.ViewCount)
}
