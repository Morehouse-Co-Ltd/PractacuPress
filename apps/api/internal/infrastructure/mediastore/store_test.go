package mediastore_test

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
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

func TestQuotaReservationsCountAssetsAndLiveUploads(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	quotaRepo, ok := any(store).(media.QuotaReservationRepository)
	require.True(t, ok, "the media store must implement atomic quota reservations")

	for _, asset := range []media.Asset{
		{SiteID: siteID, OwnerID: "u1", StorageKey: "asset/u1.png", MIME: "image/png", Size: 800, ScanStatus: media.ScanClean, CreatedAt: now},
		{SiteID: siteID, OwnerID: "u2", StorageKey: "asset/u2.png", MIME: "image/png", Size: 400, ScanStatus: media.ScanClean, CreatedAt: now},
	} {
		_, err := store.InsertAsset(ctx, asset)
		require.NoError(t, err)
	}

	for _, seed := range []struct {
		owner   string
		size    int64
		expires time.Time
		status  media.UploadStatus
	}{
		{owner: "u1", size: 200, expires: now.Add(time.Hour), status: media.UploadPending},
		{owner: "u3", size: 100, expires: now.Add(time.Hour), status: media.UploadUploaded},
		{owner: "u2", size: 5000, expires: now.Add(-time.Second), status: media.UploadPending},
		{owner: "u3", size: 500, expires: now.Add(time.Hour), status: media.UploadPending},
	} {
		upload, err := store.InsertUpload(ctx, media.Upload{
			SiteID: siteID, OwnerID: seed.owner, FileName: "seed.png", DeclaredMIME: "image/png",
			Size: seed.size, Purpose: media.PurposeContent, StorageKey: media.NewStorageKey("seed.png"),
			ExpiresAt: seed.expires, CreatedAt: now,
		})
		require.NoError(t, err)
		if seed.status == media.UploadUploaded {
			require.NoError(t, store.MarkUploadUploaded(ctx, upload.ID, now))
		}
		if seed.size == 500 {
			require.NoError(t, store.MarkUploadCompleted(ctx, upload.ID, now))
		}
	}

	request := media.Upload{
		SiteID: siteID, OwnerID: "u1", FileName: "new.png", DeclaredMIME: "image/png",
		Size: 500, Purpose: media.PurposeContent, StorageKey: media.NewStorageKey("new.png"),
		ExpiresAt: now.Add(media.UploadTTL), CreatedAt: now,
	}
	_, err := quotaRepo.InsertUploadWithinQuota(ctx, request, 1500, 2000)
	require.NoError(t, err, "exactly reaching both limits is allowed")

	request.Size = 1
	request.StorageKey = media.NewStorageKey("over-user.png")
	_, err = quotaRepo.InsertUploadWithinQuota(ctx, request, 1500, 3000)
	require.ErrorIs(t, err, media.ErrQuotaExceeded, "the user's existing assets and live reservation count")

	request.OwnerID = "u4"
	request.StorageKey = media.NewStorageKey("over-site.png")
	_, err = quotaRepo.InsertUploadWithinQuota(ctx, request, 10_000, 2000)
	require.ErrorIs(t, err, media.ErrQuotaExceeded, "all owners' assets and live reservations count toward the site")
}

func TestMediaQuotaOverridesReadSiteAndActiveMemberSettings(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()

	siteLimit := int64(10_240)
	_, err := handle.Client.Site.UpdateOneID(siteID).SetMediaQuotaBytes(siteLimit).Save(ctx)
	require.NoError(t, err)
	memberLimit := int64(4_096)
	_, err = handle.Client.SiteMember.Create().
		SetSiteID(siteID).SetUserID("u1").SetMediaQuotaBytes(memberLimit).Save(ctx)
	require.NoError(t, err)

	overrides, err := store.MediaQuotaOverrides(ctx, siteID, "u1")
	require.NoError(t, err)
	require.NotNil(t, overrides.SiteBytes)
	require.Equal(t, siteLimit, *overrides.SiteBytes)
	require.NotNil(t, overrides.UserBytes)
	require.Equal(t, memberLimit, *overrides.UserBytes)
}

func TestMediaQuotaOverridesKeepsExplicitUnlimitedAndInheritsNil(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()

	_, err := handle.Client.Site.UpdateOneID(siteID).SetMediaQuotaBytes(0).Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.SiteMember.Create().SetSiteID(siteID).SetUserID("u1").Save(ctx)
	require.NoError(t, err)

	overrides, err := store.MediaQuotaOverrides(ctx, siteID, "u1")
	require.NoError(t, err)
	require.NotNil(t, overrides.SiteBytes, "explicit site zero is distinct from inheriting nil")
	require.Zero(t, *overrides.SiteBytes)
	require.Nil(t, overrides.UserBytes, "missing member override inherits the deployment default")
}

func TestMediaQuotaOverridesRejectsMissingOrInactiveMembership(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()

	_, err := store.MediaQuotaOverrides(ctx, siteID, "missing")
	require.ErrorIs(t, err, media.ErrPermissionDenied)

	_, err = handle.Client.SiteMember.Create().
		SetSiteID(siteID).SetUserID("u1").SetStatus("suspended").Save(ctx)
	require.NoError(t, err)
	_, err = store.MediaQuotaOverrides(ctx, siteID, "u1")
	require.ErrorIs(t, err, media.ErrPermissionDenied)
}

func TestQuotaReservationsSerializeConcurrentRequests(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()
	quotaRepo, ok := any(store).(media.QuotaReservationRepository)
	require.True(t, ok, "the media store must implement atomic quota reservations")

	const workers = 8
	start := make(chan struct{})
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, err := quotaRepo.InsertUploadWithinQuota(ctx, media.Upload{
				SiteID: siteID, OwnerID: "u1", FileName: "race.png", DeclaredMIME: "image/png",
				Size: 1024, Purpose: media.PurposeContent, StorageKey: fmt.Sprintf("race/%d.png", i),
				ExpiresAt: time.Now().UTC().Add(media.UploadTTL), CreatedAt: time.Now().UTC(),
			}, 1024, 1024)
			errs <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(errs)

	accepted := 0
	for err := range errs {
		if err == nil {
			accepted++
			continue
		}
		require.ErrorIs(t, err, media.ErrQuotaExceeded)
	}
	require.Equal(t, 1, accepted, "only one request may reserve the full remaining quota")
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

// TestGarbageCatalogListsAllSitesAndExpiresUploads covers the port the offline collector
// uses: unlike ListAssets it must cross the tenant boundary, and marking an abandoned
// session expired must not be able to overwrite a completed one.
func TestGarbageCatalogListsAllSitesAndExpiresUploads(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	other, err := handle.Client.Site.Create().SetSlug("other").SetName("Other").Save(ctx)
	require.NoError(t, err)

	insertAsset(t, store, siteID, media.PurposeContent, media.ScanClean, now)
	insertAsset(t, store, other.ID, media.PurposeContent, media.ScanRejected, now)

	upload, err := store.InsertUpload(ctx, media.Upload{
		SiteID: siteID, OwnerID: "u1", FileName: "a.png", DeclaredMIME: "image/png",
		Size: 10, Purpose: media.PurposeContent, StorageKey: "ab/stale.png",
		Status: media.UploadUploaded, ExpiresAt: now.Add(-time.Hour), CreatedAt: now.Add(-2 * time.Hour),
	})
	require.NoError(t, err)
	require.NoError(t, store.MarkUploadUploaded(ctx, upload.ID, now))

	assets, err := store.AllAssets(ctx)
	require.NoError(t, err)
	require.Len(t, assets, 2, "the collector must see every site")

	uploads, err := store.AllUploads(ctx)
	require.NoError(t, err)
	require.Len(t, uploads, 1)
	require.Equal(t, media.UploadUploaded, uploads[0].Status)

	require.NoError(t, store.MarkUploadExpired(ctx, upload.ID, now))
	found, err := store.FindUpload(ctx, siteID, upload.ID)
	require.NoError(t, err)
	require.Equal(t, media.UploadExpired, found.Status)

	// A second pass sees a closed session and leaves it alone.
	require.NoError(t, store.MarkUploadExpired(ctx, upload.ID, now))
	found, err = store.FindUpload(ctx, siteID, upload.ID)
	require.NoError(t, err)
	require.Equal(t, media.UploadExpired, found.Status)
}

// TestAssetKeepsTheDeclaredFileName pins the display name round trip: the dashboard shows
// the name the uploader declared, and the storage key stays independent of it.
func TestAssetKeepsTheDeclaredFileName(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()

	created, err := store.InsertAsset(ctx, media.Asset{
		SiteID: siteID, OwnerID: "u1", FileName: "Quarterly report.png",
		StorageKey: "ab/abcdef.png", MIME: "image/png", Size: 10,
		ScanStatus: media.ScanClean, Purpose: media.PurposeContent, CreatedAt: time.Now().UTC(),
	})
	require.NoError(t, err)
	require.Equal(t, "Quarterly report.png", created.FileName)

	found, err := store.FindAsset(ctx, siteID, created.ID)
	require.NoError(t, err)
	require.Equal(t, "Quarterly report.png", found.FileName)
	require.NotContains(t, found.StorageKey, "Quarterly",
		"the name is display only; the key is generated on its own")

	// A row written before the column existed keeps working with an empty name, which is
	// what lets the dashboard fall back to the key instead of showing a blank label.
	legacy, err := store.InsertAsset(ctx, media.Asset{
		SiteID: siteID, OwnerID: "u1", StorageKey: "ab/legacy.png", MIME: "image/png",
		Size: 4, ScanStatus: media.ScanClean, Purpose: media.PurposeContent,
		CreatedAt: time.Now().UTC(),
	})
	require.NoError(t, err)
	require.Empty(t, legacy.FileName)
}

// TestAssetInUseSeesEveryKindOfReference is the delete guard against the real schema.
//
// Every place content can name a media object keeps it alive: the HTML a page serves, the
// markdown its author edits, and the two cover fields. A trashed item counts too, because
// restoring it is exactly what the recycle bin promises. Another site's reference does not.
func TestAssetInUseSeesEveryKindOfReference(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()

	other, err := handle.Client.Site.Create().SetSlug("other").SetName("Other").Save(ctx)
	require.NoError(t, err)

	// seedItem writes one content item; only the fields a reference can live in matter.
	seedItem := func(siteID, body, cover, ogImage, status string, trashed bool) {
		t.Helper()
		builder := handle.Client.ContentItem.Create().
			SetSiteID(siteID).
			SetAuthorID("u1").
			SetKind("article").
			SetTitle("Item").
			SetSourceBody(body).
			SetRenderedHTML("<p>" + body + "</p>").
			SetCoverURL(cover).
			SetOgImage(ogImage).
			SetStatus(status)
		if trashed {
			builder.SetDeletedAt(time.Now().UTC())
		}
		_, saveErr := builder.Save(ctx)
		require.NoError(t, saveErr)
	}

	const (
		draftRef     = "draft-asset-id"
		publishedRef = "published-asset-id"
		coverRef     = "cover-asset-id"
		ogRef        = "og-asset-id"
		trashRef     = "trashed-asset-id"
		foreignRef   = "foreign-asset-id"
		keyOnlyRef   = "ab/key-only.png"
	)

	seedItem(siteID, "![x](/api/v1/media/"+draftRef+")", "", "", "draft", false)
	seedItem(siteID, "![x](/api/v1/media/"+publishedRef+")", "", "", "published", false)
	seedItem(siteID, "", "/api/v1/media/"+coverRef, "", "published", false)
	seedItem(siteID, "", "", "/api/v1/media/"+ogRef, "draft", false)
	seedItem(siteID, "![x](/api/v1/media/"+trashRef+")", "", "", "draft", true)
	seedItem(other.ID, "![x](/api/v1/media/"+foreignRef+")", "", "", "published", false)
	seedItem(siteID, "raw key: "+keyOnlyRef, "", "", "draft", false)

	for _, assetID := range []string{draftRef, publishedRef, coverRef, ogRef, trashRef} {
		inUse, err := store.AssetInUse(ctx, siteID, assetID, "")
		require.NoError(t, err)
		require.True(t, inUse, "asset %s is still referenced", assetID)
	}

	inUse, err := store.AssetInUse(ctx, siteID, "", keyOnlyRef)
	require.NoError(t, err)
	require.True(t, inUse, "a body quoting the storage key keeps the object too")

	inUse, err = store.AssetInUse(ctx, siteID, "nobody-references-me", "")
	require.NoError(t, err)
	require.False(t, inUse)

	inUse, err = store.AssetInUse(ctx, siteID, foreignRef, "")
	require.NoError(t, err)
	require.False(t, inUse, "another site's article is not this site's reference")

	inUse, err = store.AssetInUse(ctx, "", draftRef, "")
	require.NoError(t, err)
	require.False(t, inUse, "without a site there is nothing to search")
}
