package media

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeGarbageCatalog is the database half of the collector. MarkUploadExpired updates
// the fake row so a second run sees the same state the real store would expose.
type fakeGarbageCatalog struct {
	assets  []Asset
	uploads []Upload
	expired []string
	err     error
}

func (f *fakeGarbageCatalog) AllAssets(context.Context) ([]Asset, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.assets, nil
}

func (f *fakeGarbageCatalog) AllUploads(context.Context) ([]Upload, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.uploads, nil
}

func (f *fakeGarbageCatalog) MarkUploadExpired(_ context.Context, uploadID string, _ time.Time) error {
	f.expired = append(f.expired, uploadID)
	for index := range f.uploads {
		if f.uploads[index].ID == uploadID {
			f.uploads[index].Status = UploadExpired
		}
	}
	return nil
}

func putGarbageObject(t *testing.T, storage *LocalStorage, key string) {
	t.Helper()
	payload := []byte("object " + key)
	require.NoError(t, storage.Put(context.Background(), key, bytes.NewReader(payload), int64(len(payload))))
}

func objectExists(t *testing.T, storage *LocalStorage, key string) bool {
	t.Helper()
	reader, err := storage.Open(context.Background(), key)
	if err != nil {
		return false
	}
	_ = reader.Close()
	return true
}

// garbageFixture builds a store with one of every category the collector handles.
func garbageFixture(t *testing.T) (*fakeGarbageCatalog, *LocalStorage, time.Time) {
	t.Helper()

	storage, err := NewLocalStorage(t.TempDir())
	require.NoError(t, err)
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

	catalog := &fakeGarbageCatalog{
		assets: []Asset{
			{
				ID: "a-keep", SiteID: "s1", StorageKey: "aa/keep.png", MIME: "image/png",
				ScanStatus: ScanClean, Purpose: PurposeContent, CreatedAt: now.Add(-48 * time.Hour),
			},
			{
				ID: "a-rejected", SiteID: "s1", StorageKey: "dd/rejected.png", MIME: "image/png",
				ScanStatus: ScanRejected, Purpose: PurposeContent, CreatedAt: now.Add(-48 * time.Hour),
			},
			{
				ID: "a-recent", SiteID: "s1", StorageKey: "dd/recent.png", MIME: "image/png",
				ScanStatus: ScanRejected, Purpose: PurposeContent, CreatedAt: now.Add(-time.Hour),
			},
		},
		uploads: []Upload{
			{
				ID: "u-active", SiteID: "s1", StorageKey: "ee/active.png", Purpose: PurposeContent,
				Status: UploadUploaded, ExpiresAt: now.Add(time.Hour),
			},
			{
				ID: "u-stale", SiteID: "s1", StorageKey: "ee/stale.png", Purpose: PurposeContent,
				Status: UploadUploaded, ExpiresAt: now.Add(-2 * time.Hour),
			},
			{
				ID: "u-completed", SiteID: "s1", StorageKey: "ff/completed.png", Purpose: PurposeContent,
				Status: UploadCompleted, ExpiresAt: now.Add(time.Hour),
			},
		},
	}

	for _, key := range []string{
		"aa/keep.png",
		"aa/keep.png.w320.png",
		"bb/orphan.png",
		"cc/gone.png.w768.jpg",
		"dd/rejected.png",
		"dd/rejected.png.w320.png",
		"dd/recent.png",
		"ee/active.png",
		"ee/stale.png",
		"ff/completed.png",
	} {
		putGarbageObject(t, storage, key)
	}

	return catalog, storage, now
}

func newTestCollector(
	t *testing.T,
	catalog *fakeGarbageCatalog,
	storage Storage,
	now time.Time,
) *Collector {
	t.Helper()
	collector, err := NewCollector(CollectorConfig{
		Catalog:           catalog,
		Storage:           storage,
		Now:               func() time.Time { return now },
		RejectedRetention: DefaultRejectedRetention,
		UploadGrace:       DefaultUploadGrace,
		// The fixtures use readable names instead of generated UUID keys; the command
		// keeps the guard on, which is tested separately.
		AllowUnknownKeys: true,
	})
	require.NoError(t, err)
	return collector
}

func TestIsMediaObjectKey(t *testing.T) {
	key := NewStorageKey("photo.png")
	require.True(t, isMediaObjectKey(key), key)
	require.True(t, isMediaObjectKey(DerivativeKey(key, 320, "png")))
	require.True(t, isMediaObjectKey(NewStorageKey("no-extension")))

	for _, foreign := range []string{
		"notes/readme.txt",
		"zz/orphan.png",
		"aa/../etc/passwd",
		"01/not-a-uuid.png",
	} {
		require.False(t, isMediaObjectKey(foreign), foreign)
	}
}

func TestCollectorSkipsUnknownKeyShapesByDefault(t *testing.T) {
	storage, err := NewLocalStorage(t.TempDir())
	require.NoError(t, err)
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	putGarbageObject(t, storage, "notes/readme.txt")

	config := CollectorConfig{
		Catalog: &fakeGarbageCatalog{},
		Storage: storage,
		Now:     func() time.Time { return now },
	}

	guarded, err := NewCollector(config)
	require.NoError(t, err)
	report, err := guarded.Run(context.Background(), false)
	require.NoError(t, err)
	require.Equal(t, 1, report.SkippedUnknown)
	require.Zero(t, report.OrphanObjects)
	require.True(t, objectExists(t, storage, "notes/readme.txt"),
		"a shared bucket or directory must not lose unrelated files")

	// The opt-in is explicit, for an operator who really owns every object in the store.
	config.AllowUnknownKeys = true
	unguarded, err := NewCollector(config)
	require.NoError(t, err)
	report, err = unguarded.Run(context.Background(), false)
	require.NoError(t, err)
	require.Equal(t, 1, report.OrphanObjects)
	require.Equal(t, 1, report.Deleted)
	require.False(t, objectExists(t, storage, "notes/readme.txt"))
}

func TestCollectorDryRunReportsWithoutDeleting(t *testing.T) {
	catalog, storage, now := garbageFixture(t)
	collector := newTestCollector(t, catalog, storage, now)

	report, err := collector.Run(context.Background(), true)
	require.NoError(t, err)

	require.True(t, report.DryRun)
	require.Equal(t, 0, report.Deleted)
	require.Greater(t, report.WouldDelete, 0)
	require.Equal(t, 3, report.Assets)
	require.Equal(t, 1, report.RejectedAssets)
	require.Equal(t, 1, report.ExpiredUploads)
	require.Equal(t, 3, report.OrphanObjects, "orphan.png, gone.png.w768.jpg and completed.png")
	require.Empty(t, report.Errors)

	// Nothing was deleted and no session was closed.
	for _, key := range []string{
		"aa/keep.png", "bb/orphan.png", "dd/rejected.png", "ee/stale.png", "ff/completed.png",
	} {
		require.True(t, objectExists(t, storage, key), key)
	}
	require.Empty(t, catalog.expired)
}

func TestCollectorRemovesGarbageAndKeepsLiveObjects(t *testing.T) {
	catalog, storage, now := garbageFixture(t)
	collector := newTestCollector(t, catalog, storage, now)

	report, err := collector.Run(context.Background(), false)
	require.NoError(t, err)
	require.False(t, report.DryRun)
	require.Equal(t, 23, report.Deleted)
	require.Zero(t, report.WouldDelete, "a real run deletes instead of predicting")
	require.Equal(t, 3, report.OrphanObjects)
	require.Empty(t, report.Errors)

	for _, key := range []string{
		"aa/keep.png",
		"aa/keep.png.w320.png",
		"dd/recent.png",
		"ee/active.png",
	} {
		require.True(t, objectExists(t, storage, key), "%s must survive: %s", key, report.Errors)
	}
	for _, key := range []string{
		"bb/orphan.png",
		"cc/gone.png.w768.jpg",
		"dd/rejected.png",
		"dd/rejected.png.w320.png",
		"ee/stale.png",
		"ff/completed.png",
	} {
		require.False(t, objectExists(t, storage, key), "%s must be collected", key)
	}
	require.Equal(t, []string{"u-stale"}, catalog.expired,
		"the abandoned session is closed so the next run does not report it again")

	// A second pass is harmless: no orphan is left and no session is stale.
	second, err := collector.Run(context.Background(), false)
	require.NoError(t, err)
	require.Equal(t, 0, second.OrphanObjects)
	require.Equal(t, 0, second.ExpiredUploads)
	require.Empty(t, second.Errors)
	require.Equal(t, []string{"u-stale"}, catalog.expired,
		"a closed session is not marked expired twice")
}

func TestCollectorReportsStoragesItCannotList(t *testing.T) {
	// A custom adapter can still delete eagerly; without List the collector must say
	// so rather than pretend the store was scanned.
	storage := &deleteOnlyStorage{}
	collector, err := NewCollector(CollectorConfig{
		Catalog: &fakeGarbageCatalog{assets: []Asset{{
			ID: "a1", SiteID: "s1", StorageKey: "aa/known.png",
			ScanStatus: ScanClean, Purpose: PurposeContent, CreatedAt: time.Now().UTC(),
		}}},
		Storage: storage,
		Now:     func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)

	report, err := collector.Run(context.Background(), false)
	require.NoError(t, err)
	require.Equal(t, []string{"global"}, report.Unlistable)
	require.Zero(t, storage.deletes)
}

// TestCollectorKeepsAssetBytesWhenAStaleUploadSharesTheKey covers the half-completed
// upload case: InsertAsset succeeded but MarkUploadCompleted failed, so an uploaded row
// with the same key later looks abandoned. The asset still owns those bytes.
func TestCollectorKeepsAssetBytesWhenAStaleUploadSharesTheKey(t *testing.T) {
	storage, err := NewLocalStorage(t.TempDir())
	require.NoError(t, err)
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

	key := "aa/shared.png"
	putGarbageObject(t, storage, key)
	putGarbageObject(t, storage, DerivativeKey(key, 320, "png"))

	catalog := &fakeGarbageCatalog{
		assets: []Asset{{
			ID: "a1", SiteID: "s1", StorageKey: key, MIME: "image/png",
			ScanStatus: ScanClean, Purpose: PurposeContent, CreatedAt: now.Add(-48 * time.Hour),
		}},
		uploads: []Upload{{
			ID: "u1", SiteID: "s1", StorageKey: key, Purpose: PurposeContent,
			Status: UploadUploaded, ExpiresAt: now.Add(-2 * time.Hour),
		}},
	}

	collector := newTestCollector(t, catalog, storage, now)
	report, err := collector.Run(context.Background(), false)
	require.NoError(t, err)

	require.Equal(t, 1, report.ExpiredUploads)
	require.Equal(t, 0, report.OrphanObjects)
	require.Equal(t, 0, report.Deleted)
	require.Empty(t, report.Errors)
	require.True(t, objectExists(t, storage, key))
	require.True(t, objectExists(t, storage, DerivativeKey(key, 320, "png")))
	require.Equal(t, []string{"u1"}, catalog.expired,
		"the stale session is still closed, even though its object belongs to an asset")
}

// deleteOnlyStorage implements Storage without the optional ObjectLister capability.
type deleteOnlyStorage struct {
	deletes int
}

func (s *deleteOnlyStorage) Put(context.Context, string, io.Reader, int64) error { return nil }

func (s *deleteOnlyStorage) ReadHead(context.Context, string, int) ([]byte, error) {
	return nil, ErrStorageObjectMissing
}
func (s *deleteOnlyStorage) Open(context.Context, string) (io.ReadCloser, error) {
	return nil, ErrStorageObjectMissing
}
func (s *deleteOnlyStorage) Delete(context.Context, string) error {
	s.deletes++
	return nil
}
