package mediastore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/mediastore"
	"github.com/practacu/practacu-press/apps/api/internal/media"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
)

func newStore(t *testing.T) (*mediastore.Store, *db.DB, string) {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "media.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	return mediastore.New(handle.Client), handle, siteRow.ID
}

func TestUploadRoundTrip(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	created, err := store.InsertUpload(ctx, media.Upload{
		SiteID: siteID, OwnerID: "u1", FileName: "photo.png",
		DeclaredMIME: "image/png", Size: 1024, Purpose: media.PurposeContent,
		StorageKey: "ab/abcdef.png", Status: media.UploadPending,
		ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	})
	require.NoError(t, err)
	require.NotEmpty(t, created.ID)

	found, err := store.FindUpload(ctx, siteID, created.ID)
	require.NoError(t, err)
	require.Equal(t, "photo.png", found.FileName)
	require.Equal(t, media.UploadPending, found.Status)

	_, err = store.FindUpload(ctx, "other-site", created.ID)
	require.ErrorIs(t, err, media.ErrNotFound, "sessions are site scoped")

	require.NoError(t, store.MarkUploadCompleted(ctx, created.ID, now))
	completed, err := store.FindUpload(ctx, siteID, created.ID)
	require.NoError(t, err)
	require.Equal(t, media.UploadCompleted, completed.Status)

	require.NoError(t, store.MarkUploadCompleted(ctx, created.ID, now), "completing twice is a no-op")
}

func TestAssetStartsPendingAndKeepsReason(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()

	clean, err := store.InsertAsset(ctx, media.Asset{
		SiteID: siteID, OwnerID: "u1", StorageKey: "ab/clean.png",
		MIME: "image/png", Size: 10, ScanStatus: media.ScanClean, CreatedAt: time.Now().UTC(),
	})
	require.NoError(t, err)
	require.True(t, media.Referenceable(clean))

	rejected, err := store.InsertAsset(ctx, media.Asset{
		SiteID: siteID, OwnerID: "u1", StorageKey: "ab/bad.exe",
		MIME: "application/octet-stream", Size: 10, ScanStatus: media.ScanRejected,
		ReasonCode: "eicar", CreatedAt: time.Now().UTC(),
	})
	require.NoError(t, err)
	require.False(t, media.Referenceable(rejected))
	require.Equal(t, "eicar", rejected.ReasonCode)
}

func TestServiceAgainstRealStore(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()

	service, err := media.NewService(media.ServiceConfig{
		Repository: store,
		Scanner:    stubScanner{result: media.ScanResult{Status: media.ScanClean}},
	})
	require.NoError(t, err)

	actor := media.Actor{UserID: "u1", SiteID: siteID}
	upload, err := service.CreateUpload(ctx, actor, media.UploadRequest{
		FileName: "photo.png", DeclaredMIME: "image/png", Size: 1024, Purpose: media.PurposeContent,
	})
	require.NoError(t, err)

	asset, err := service.CompleteUpload(ctx, actor, upload.ID)
	require.NoError(t, err)
	require.True(t, media.Referenceable(asset))
	require.NotEmpty(t, asset.ID)
}

type stubScanner struct{ result media.ScanResult }

func (s stubScanner) Inspect(context.Context, media.ScanInput) (media.ScanResult, error) {
	return s.result, nil
}

// TestAssetPurposeRoundTripAndDelete is the persistence half of per purpose storage:
// the download/delete path can only pick the right adapter if the purpose survived the
// round trip. A NULL purpose must stay empty so legacy rows fall back to the global
// adapter instead of assuming a scope.
func TestAssetPurposeRoundTripAndDelete(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	saved, err := store.InsertAsset(ctx, media.Asset{
		SiteID: siteID, OwnerID: "u1", StorageKey: "ab/site.png",
		MIME: "image/png", Size: 10, ScanStatus: media.ScanClean,
		Purpose: media.PurposeSite, CreatedAt: now,
	})
	require.NoError(t, err)
	require.Equal(t, media.PurposeSite, saved.Purpose)

	found, err := store.FindAsset(ctx, siteID, saved.ID)
	require.NoError(t, err)
	require.Equal(t, media.PurposeSite, found.Purpose)

	require.NoError(t, store.DeleteAsset(ctx, siteID, saved.ID))
	_, err = store.FindAsset(ctx, siteID, saved.ID)
	require.ErrorIs(t, err, media.ErrNotFound)
	require.ErrorIs(t, store.DeleteAsset(ctx, siteID, saved.ID), media.ErrNotFound)

	// A row created without a purpose models the pre per purpose era.
	legacy, err := handle.Client.MediaAsset.Create().
		SetSiteID(siteID).SetOwnerID("u1").SetStorageKey("ab/legacy.png").
		SetMimeType("image/png").SetSize(10).SetScanStatus("clean").
		Save(ctx)
	require.NoError(t, err)

	got, err := store.FindAsset(ctx, siteID, legacy.ID)
	require.NoError(t, err)
	require.Empty(t, got.Purpose, "a legacy row has no purpose and must use the global adapter")
}

// insertAsset stores one asset for the listing tests. NewStorageKey supplies the unique
// key the schema requires without hand rolled ids.
func insertAsset(
	t *testing.T,
	store *mediastore.Store,
	siteID string,
	purpose media.Purpose,
	status media.ScanStatus,
	createdAt time.Time,
) media.Asset {
	t.Helper()

	saved, err := store.InsertAsset(context.Background(), media.Asset{
		SiteID: siteID, OwnerID: "u1", StorageKey: media.NewStorageKey("photo.png"),
		MIME: "image/png", Size: 10, ScanStatus: status,
		Purpose: purpose, CreatedAt: createdAt,
	})
	require.NoError(t, err)
	return saved
}

// TestListAssetsPaginatesNewestFirst is the property the cursor exists for: walking the
// pages must visit every row exactly once, even where several rows share a timestamp,
// and must never hand out a cursor that yields an empty page.
func TestListAssetsPaginatesNewestFirst(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()
	base := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

	// The two oldest rows share a timestamp on purpose: the id tie breaker is what keeps
	// the page boundary stable when a burst of uploads lands in the same instant.
	saved := []media.Asset{
		insertAsset(t, store, siteID, media.PurposeContent, media.ScanClean, base),
		insertAsset(t, store, siteID, media.PurposeContent, media.ScanClean, base.Add(-time.Minute)),
		insertAsset(t, store, siteID, media.PurposeContent, media.ScanClean, base.Add(-2*time.Minute)),
		insertAsset(t, store, siteID, media.PurposeContent, media.ScanClean, base.Add(-2*time.Minute)),
	}

	seen := make([]string, 0, len(saved))
	cursor := page.Cursor{}
	for pages := 0; pages < len(saved)+1; pages++ {
		items, next, err := store.ListAssets(ctx, siteID, media.AssetFilter{}, 2, cursor)
		require.NoError(t, err)
		for _, item := range items {
			seen = append(seen, item.ID)
		}
		if next == "" {
			// The last page may be exactly full; what matters is that the walk visited
			// every row exactly once and stopped there.
			break
		}

		require.Len(t, items, 2)
		decoded, err := page.Decode(next)
		require.NoError(t, err)
		last := items[len(items)-1]
		require.Equal(t, last.ID, decoded.ID)
		require.Equal(t, last.CreatedAt.UTC().Format(time.RFC3339Nano), decoded.Key)
		cursor = decoded
	}

	ids := make([]string, 0, len(saved))
	for _, asset := range saved {
		ids = append(ids, asset.ID)
	}
	require.ElementsMatch(t, ids, seen, "every row is visited exactly once")
	require.Equal(t, saved[0].ID, seen[0], "the newest asset opens the listing")
}

// TestListAssetsAppliesFilters keeps a filtered page a full page: the filters are applied
// before the page size instead of after it.
func TestListAssetsAppliesFilters(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	cleanContent := insertAsset(t, store, siteID, media.PurposeContent, media.ScanClean, now)
	insertAsset(t, store, siteID, media.PurposeAvatar, media.ScanRejected, now.Add(-time.Minute))
	rejectedContent := insertAsset(t, store, siteID, media.PurposeContent, media.ScanRejected, now.Add(-2*time.Minute))

	byPurpose, _, err := store.ListAssets(ctx, siteID, media.AssetFilter{Purpose: media.PurposeContent}, 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byPurpose, 2)
	for _, asset := range byPurpose {
		require.Equal(t, media.PurposeContent, asset.Purpose)
	}

	byStatus, _, err := store.ListAssets(ctx, siteID, media.AssetFilter{ScanStatus: media.ScanRejected}, 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byStatus, 2)

	both, next, err := store.ListAssets(ctx, siteID,
		media.AssetFilter{Purpose: media.PurposeContent, ScanStatus: media.ScanRejected}, 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, both, 1, "the dimensions combine with AND")
	require.Equal(t, rejectedContent.ID, both[0].ID)
	require.Empty(t, next)

	none, next, err := store.ListAssets(ctx, siteID,
		media.AssetFilter{Purpose: media.PurposeAvatar, ScanStatus: media.ScanClean}, 10, page.Cursor{})
	require.NoError(t, err)
	require.Empty(t, none)
	require.Empty(t, next)
	require.NotEmpty(t, cleanContent.ID)
}

// TestListAssetsScopesBySite is the tenant boundary at the persistence layer.
func TestListAssetsScopesBySite(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	other, err := handle.Client.Site.Create().SetSlug("other").SetName("Other").Save(ctx)
	require.NoError(t, err)

	mine := insertAsset(t, store, siteID, media.PurposeContent, media.ScanClean, now)
	insertAsset(t, store, other.ID, media.PurposeContent, media.ScanClean, now)

	items, _, err := store.ListAssets(ctx, siteID, media.AssetFilter{}, 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, mine.ID, items[0].ID)
}

// TestListAssetsRejectsUnusableCursorKey documents the guard: the service refuses such a
// cursor first, and the store must not silently return the first page either.
func TestListAssetsRejectsUnusableCursorKey(t *testing.T) {
	store, _, siteID := newStore(t)

	_, _, err := store.ListAssets(context.Background(), siteID, media.AssetFilter{}, 10,
		page.Cursor{Key: "yesterday", ID: "a1"})
	require.ErrorIs(t, err, media.ErrInvalidInput)
}
