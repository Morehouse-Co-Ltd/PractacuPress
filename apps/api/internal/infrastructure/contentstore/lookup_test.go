package contentstore_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// seedSlug inserts one row with an explicit slug, kind and timestamps. It bypasses the
// service because slug duplicates and the recycle bin marker are not reachable through
// the ordinary authoring flow, and these tests assert the resolution rules around them.
func seedSlug(
	t *testing.T,
	h *harness,
	id, slug string,
	kind content.Kind,
	createdAt time.Time,
	deletedAt *time.Time,
) {
	t.Helper()

	create := h.db.Client.ContentItem.Create().
		SetID(id).
		SetSiteID(h.siteID).
		SetAuthorID("author_1").
		SetKind(string(kind)).
		SetStatus(string(content.StatusPublished)).
		SetTitle(id).
		SetSlug(slug).
		SetSourceBody("body").
		SetCreatedAt(createdAt).
		SetUpdatedAt(createdAt)
	if deletedAt != nil {
		create = create.SetDeletedAt(*deletedAt)
	}
	_, err := create.Save(context.Background())
	require.NoError(t, err)
}

func TestFindBySlugScopesBySiteKindAndBin(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	ctx := context.Background()

	seedSlug(t, h, "article-old", "hello", content.KindArticle, seedBase, nil)
	seedSlug(t, h, "post-new", "hello", content.KindPost, seedBase.Add(time.Hour), nil)
	// A duplicate slug of the same kind: the oldest row keeps the address.
	seedSlug(t, h, "article-new", "hello", content.KindArticle, seedBase.Add(2*time.Hour), nil)

	trashed := seedBase
	seedSlug(t, h, "trashed", "gone", content.KindArticle, seedBase, &trashed)

	store := contentstore.New(h.db.Client)

	article, err := store.FindBySlug(ctx, h.siteID, content.KindArticle, "hello")
	require.NoError(t, err)
	require.Equal(t, "article-old", article.ID, "the oldest row of the kind owns the slug")

	post, err := store.FindBySlug(ctx, h.siteID, content.KindPost, "hello")
	require.NoError(t, err)
	require.Equal(t, "post-new", post.ID)

	// No kind filter is the site wide lookup, used by nothing but tests today.
	anyKind, err := store.FindBySlug(ctx, h.siteID, "", "hello")
	require.NoError(t, err)
	require.Equal(t, "article-old", anyKind.ID)

	// A trashed row is invisible to slug addressing, like every other read path.
	_, err = store.FindBySlug(ctx, h.siteID, content.KindArticle, "gone")
	require.ErrorIs(t, err, content.ErrNotFound)

	// A slug is a site scoped address.
	_, err = store.FindBySlug(ctx, "other-site", content.KindArticle, "hello")
	require.ErrorIs(t, err, content.ErrNotFound)

	// Blank input is not a lookup.
	_, err = store.FindBySlug(ctx, h.siteID, content.KindArticle, "  ")
	require.ErrorIs(t, err, content.ErrNotFound)
}

func TestFindRevisionByVersion(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, draftInput())
	require.NoError(t, err)
	for i := 0; i < 2; i++ {
		in := draftInput()
		in.SourceBody = fmt.Sprintf("# revision %d", i)
		_, err := h.service.UpdateDraft(ctx, h.author(), item.ID, in)
		require.NoError(t, err)
	}

	store := contentstore.New(h.db.Client)

	first, err := store.FindRevisionByVersion(ctx, h.siteID, item.ID, 1)
	require.NoError(t, err)
	require.Equal(t, 1, first.Version)
	require.Equal(t, draftInput().SourceBody, first.SourceBody)

	second, err := store.FindRevisionByVersion(ctx, h.siteID, item.ID, 2)
	require.NoError(t, err)
	require.Equal(t, "# revision 0", second.SourceBody)

	// A version that was never written is missing, not an empty snapshot.
	_, err = store.FindRevisionByVersion(ctx, h.siteID, item.ID, 99)
	require.ErrorIs(t, err, content.ErrNotFound)

	// The content scope matters: another item cannot read these versions.
	_, err = store.FindRevisionByVersion(ctx, h.siteID, "other-content", 1)
	require.ErrorIs(t, err, content.ErrNotFound)

	// So does the site scope.
	_, err = store.FindRevisionByVersion(ctx, "other-site", item.ID, 1)
	require.ErrorIs(t, err, content.ErrNotFound)
}
