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
