package taxonomystore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/infrastructure/taxonomystore"
	"github.com/practacu/practacu-press/internal/taxonomy"
)

func TestTermLifecycleAgainstSQLite(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "taxonomy.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	store := taxonomystore.New(handle.Client)

	category, err := store.Insert(ctx, taxonomy.Term{
		SiteID: siteRow.ID, Kind: taxonomy.KindCategory,
		Name: "Craft", Slug: "craft", Description: "essays", Color: "#2f6b4f",
		CreatedAt: now, UpdatedAt: now,
	})
	require.NoError(t, err)
	require.NotEmpty(t, category.ID)

	_, err = store.Insert(ctx, taxonomy.Term{
		SiteID: siteRow.ID, Kind: taxonomy.KindTag, Name: "Go", Slug: "craft",
		CreatedAt: now, UpdatedAt: now,
	})
	require.NoError(t, err, "the same slug is allowed for a different kind")

	_, err = store.Insert(ctx, taxonomy.Term{
		SiteID: siteRow.ID, Kind: taxonomy.KindTag, Name: "Web", Slug: "craft",
		CreatedAt: now, UpdatedAt: now,
	})
	require.ErrorIs(t, err, taxonomy.ErrConflict, "a duplicate slug of the same kind is rejected")

	terms, err := store.List(ctx, siteRow.ID)
	require.NoError(t, err)
	require.Len(t, terms, 2)
	require.Equal(t, taxonomy.KindCategory, terms[0].Kind, "categories sort before tags")

	found, err := store.FindByID(ctx, siteRow.ID, category.ID)
	require.NoError(t, err)
	require.Equal(t, "Craft", found.Name)

	found.Name = "Craft Notes"
	found.Slug = "craft-notes"
	updated, err := store.Update(ctx, found)
	require.NoError(t, err)
	require.Equal(t, "craft-notes", updated.Slug)

	content, err := handle.Client.ContentItem.Create().
		SetSiteID(siteRow.ID).
		SetAuthorID("author_1").
		SetKind("article").
		SetTitle("Tagged").
		SetSlug("tagged").
		SetSourceBody("body").
		SetCategoryID(category.ID).
		SetTags(`["Go"]`).
		Save(ctx)
	require.NoError(t, err)

	require.NoError(t, store.Delete(ctx, siteRow.ID, category.ID))
	_, err = store.FindByID(ctx, siteRow.ID, category.ID)
	require.ErrorIs(t, err, taxonomy.ErrNotFound)

	// Deleting a category clears the reference but never deletes the content.
	reloaded, err := handle.Client.ContentItem.Get(ctx, content.ID)
	require.NoError(t, err)
	require.Nil(t, reloaded.CategoryID)

	require.ErrorIs(t, store.Delete(ctx, siteRow.ID, category.ID), taxonomy.ErrNotFound)
}
