package contentstore_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/site"
)

func TestTagsRoundTrip(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	ctx := context.Background()

	in := draftInput()
	in.Tags = []string{"Go", "Web"}
	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, in)
	require.NoError(t, err)
	require.Equal(t, []string{"Go", "Web"}, item.Tags)

	stored, err := h.service.Get(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.Equal(t, []string{"Go", "Web"}, stored.Tags)

	row, err := h.db.Client.ContentItem.Get(ctx, item.ID)
	require.NoError(t, err)
	require.JSONEq(t, `["Go","Web"]`, row.Tags, "tags are persisted as a JSON array")

	in.Tags = []string{"Only"}
	updated, err := h.service.UpdateDraft(ctx, h.author(), item.ID, in)
	require.NoError(t, err)
	require.Equal(t, []string{"Only"}, updated.Tags)

	row, err = h.db.Client.ContentItem.Get(ctx, item.ID)
	require.NoError(t, err)
	require.JSONEq(t, `["Only"]`, row.Tags)

	// Clearing all tags stores an empty array rather than NULL or invalid JSON.
	in.Tags = nil
	updated, err = h.service.UpdateDraft(ctx, h.author(), item.ID, in)
	require.NoError(t, err)
	require.Empty(t, updated.Tags)
	require.NotNil(t, updated.Tags)

	row, err = h.db.Client.ContentItem.Get(ctx, item.ID)
	require.NoError(t, err)
	require.JSONEq(t, `[]`, row.Tags)
}
