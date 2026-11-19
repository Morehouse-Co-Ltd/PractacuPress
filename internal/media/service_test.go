package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
)

type fakeRepo struct {
	uploads   map[string]Upload
	assets    []Asset
	seq       int
	listCalls []listCall
	insertErr error
}

func newFakeRepo() *fakeRepo { return &fakeRepo{uploads: map[string]Upload{}} }

func (f *fakeRepo) InsertUpload(_ context.Context, upload Upload) (Upload, error) {
	if f.insertErr != nil {
		return Upload{}, f.insertErr
	}
	f.seq++
	upload.ID = fmt.Sprintf("u%d", f.seq)
	f.uploads[upload.ID] = upload
	return upload, nil
}

func (f *fakeRepo) FindUpload(_ context.Context, siteID, uploadID string) (Upload, error) {
	upload, ok := f.uploads[uploadID]
	if !ok || upload.SiteID != siteID {
		return Upload{}, ErrNotFound
	}
	return upload, nil
}

func (f *fakeRepo) MarkUploadUploaded(_ context.Context, uploadID string, _ time.Time) error {
	upload, ok := f.uploads[uploadID]
	if !ok {
		return ErrNotFound
	}
	upload.Status = UploadUploaded
	f.uploads[uploadID] = upload
	return nil
}
func (f *fakeRepo) MarkUploadCompleted(_ context.Context, uploadID string, _ time.Time) error {
	upload, ok := f.uploads[uploadID]
	if !ok {
		return ErrNotFound
	}
	upload.Status = UploadCompleted
	f.uploads[uploadID] = upload
	return nil
}

func (f *fakeRepo) FindAsset(_ context.Context, siteID, assetID string) (Asset, error) {
	for _, asset := range f.assets {
		if asset.ID == assetID && asset.SiteID == siteID {
			return asset, nil
		}
	}
	return Asset{}, ErrNotFound
}
func (f *fakeRepo) InsertAsset(_ context.Context, asset Asset) (Asset, error) {
	f.seq++
	asset.ID = fmt.Sprintf("a%d", f.seq)
	f.assets = append(f.assets, asset)
	return asset, nil
}

func (f *fakeRepo) DeleteAsset(_ context.Context, siteID, assetID string) error {
	for i, asset := range f.assets {
		if asset.ID == assetID && asset.SiteID == siteID {
			f.assets = append(f.assets[:i], f.assets[i+1:]...)
			return nil
		}
	}
	return ErrNotFound
}

// listCall records how the service asked for a page, so a test can prove the page size,
// the site scope and the filters reached the repository unchanged.
type listCall struct {
	siteID string
	filter AssetFilter
	limit  int
	after  page.Cursor
}

func (f *fakeRepo) ListAssets(
	_ context.Context,
	siteID string,
	filter AssetFilter,
	limit int,
	after page.Cursor,
) ([]Asset, string, error) {
	f.listCalls = append(f.listCalls, listCall{siteID: siteID, filter: filter, limit: limit, after: after})

	out := make([]Asset, 0, len(f.assets))
	for _, asset := range f.assets {
		if asset.SiteID != siteID {
			continue
		}
		if filter.Purpose != "" && asset.Purpose != filter.Purpose {
			continue
		}
		if filter.ScanStatus != "" && asset.ScanStatus != filter.ScanStatus {
			continue
		}
		if filter.OwnerID != "" && asset.OwnerID != filter.OwnerID {
			continue
		}
		out = append(out, asset)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})

	next := ""
	if limit > 0 && len(out) > limit {
		out = out[:limit]
		last := out[len(out)-1]
		next = page.Cursor{Key: last.CreatedAt.UTC().Format(time.RFC3339Nano), ID: last.ID}.Encode()
	}
	return out, next, nil
}

// lastList returns the most recent listing call, or a zero value when none was made.
func (f *fakeRepo) lastList() listCall {
	if len(f.listCalls) == 0 {
		return listCall{}
	}
	return f.listCalls[len(f.listCalls)-1]
}

type fakeScanner struct {
	result ScanResult
	err    error
	calls  int
}

func (f *fakeScanner) Inspect(context.Context, ScanInput) (ScanResult, error) {
	f.calls++
	if f.err != nil {
		return ScanResult{}, f.err
	}
	return f.result, nil
}

func newService(t *testing.T, repo Repository, scanner Scanner) *Service {
	t.Helper()
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Scanner:    scanner,
		Now:        func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)
	return service
}

func owner() Actor { return Actor{UserID: "u1", SiteID: "s1", Role: site.RoleEditor} }

type quotaCaptureRepo struct {
	*fakeRepo
	userLimit int64
	siteLimit int64
	calls     int
}

func (f *quotaCaptureRepo) InsertUploadWithinQuota(
	ctx context.Context,
	upload Upload,
	userLimitBytes, siteLimitBytes int64,
) (Upload, error) {
	f.calls++
	f.userLimit = userLimitBytes
	f.siteLimit = siteLimitBytes
	if userLimitBytes > 0 && upload.Size > userLimitBytes || siteLimitBytes > 0 && upload.Size > siteLimitBytes {
		return Upload{}, ErrQuotaExceeded
	}
	return f.fakeRepo.InsertUpload(ctx, upload)
}

type fakeQuotaReader struct {
	overrides QuotaOverrides
	calls     int
	err       error
}

func (f *fakeQuotaReader) MediaQuotaOverrides(context.Context, string, string) (QuotaOverrides, error) {
	f.calls++
	return f.overrides, f.err
}

func quotaBytes(value int64) *int64 { return &value }

// member is a non-privileged caller: it may act on its own uploads but the site wide
// library and other people's private assets stay closed.
func member() Actor { return Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember} }

func imageRequest() UploadRequest {
	return UploadRequest{FileName: "photo.png", DeclaredMIME: "image/png", Size: 1024, Purpose: PurposeContent}
}

func TestNewServiceRequiresDependencies(t *testing.T) {
	_, err := NewService(ServiceConfig{})
	require.Error(t, err)

	_, err = NewService(ServiceConfig{Repository: newFakeRepo()})
	require.Error(t, err, "a scanner is mandatory: uploads must never skip inspection")
}

func TestCreateUploadAssignsOpaqueKey(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}})

	upload, err := service.CreateUpload(context.Background(), owner(), imageRequest())
	require.NoError(t, err)
	require.Equal(t, UploadPending, upload.Status)
	require.NotEmpty(t, upload.StorageKey)
	require.NotContains(t, upload.StorageKey, "photo")
	require.True(t, upload.ExpiresAt.After(upload.CreatedAt))
}

func TestCreateUploadUsesDeploymentQuotaDefaults(t *testing.T) {
	repo := &quotaCaptureRepo{fakeRepo: newFakeRepo()}
	service, err := NewService(ServiceConfig{
		Repository:    repo,
		Scanner:       &fakeScanner{result: ScanResult{Status: ScanClean}},
		QuotaDefaults: QuotaDefaults{UserBytes: 2048, SiteBytes: 4096},
	})
	require.NoError(t, err)

	_, err = service.CreateUpload(context.Background(), owner(), imageRequest())
	require.NoError(t, err)
	require.Equal(t, 1, repo.calls)
	require.EqualValues(t, 2048, repo.userLimit)
	require.EqualValues(t, 4096, repo.siteLimit)
}

func TestCreateUploadAppliesOverridesWhenDeploymentDefaultsAreUnlimited(t *testing.T) {
	repo := &quotaCaptureRepo{fakeRepo: newFakeRepo()}
	reader := &fakeQuotaReader{overrides: QuotaOverrides{UserBytes: quotaBytes(2048)}}
	service, err := NewService(ServiceConfig{
		Repository:     repo,
		Scanner:        &fakeScanner{result: ScanResult{Status: ScanClean}},
		QuotaOverrides: reader,
	})
	require.NoError(t, err)

	_, err = service.CreateUpload(context.Background(), owner(), imageRequest())
	require.NoError(t, err)
	require.Equal(t, 1, reader.calls)
	require.Equal(t, 1, repo.calls)
	require.EqualValues(t, 2048, repo.userLimit)
	require.Zero(t, repo.siteLimit, "an unset site limit inherits the unlimited deployment default")
}

func TestCreateUploadHonorsExplicitUnlimitedOverride(t *testing.T) {
	repo := &quotaCaptureRepo{fakeRepo: newFakeRepo()}
	reader := &fakeQuotaReader{overrides: QuotaOverrides{UserBytes: quotaBytes(0)}}
	service, err := NewService(ServiceConfig{
		Repository:     repo,
		Scanner:        &fakeScanner{result: ScanResult{Status: ScanClean}},
		QuotaDefaults:  QuotaDefaults{UserBytes: 2048, SiteBytes: 4096},
		QuotaOverrides: reader,
	})
	require.NoError(t, err)

	_, err = service.CreateUpload(context.Background(), owner(), imageRequest())
	require.NoError(t, err)
	require.EqualValues(t, 0, repo.userLimit, "an explicit zero override means unlimited for this member")
	require.EqualValues(t, 4096, repo.siteLimit, "the site limit remains independent")
}

func TestCreateUploadReturnsQuotaExceeded(t *testing.T) {
	repo := &quotaCaptureRepo{fakeRepo: newFakeRepo()}
	service, err := NewService(ServiceConfig{
		Repository:    repo,
		Scanner:       &fakeScanner{result: ScanResult{Status: ScanClean}},
		QuotaDefaults: QuotaDefaults{UserBytes: 512, SiteBytes: 4096},
	})
	require.NoError(t, err)

	_, err = service.CreateUpload(context.Background(), owner(), imageRequest())
	require.ErrorIs(t, err, ErrQuotaExceeded)
}

func TestCreateUploadValidatesRequest(t *testing.T) {
	service := newService(t, newFakeRepo(), &fakeScanner{})

	req := imageRequest()
	req.DeclaredMIME = "application/x-msdownload"
	_, err := service.CreateUpload(context.Background(), owner(), req)
	require.Error(t, err)
}

func TestCompleteUploadMarksCleanAsset(t *testing.T) {
	repo := newFakeRepo()
	scanner := &fakeScanner{result: ScanResult{Status: ScanClean}}
	service := newService(t, repo, scanner)
	ctx := context.Background()

	upload, err := service.CreateUpload(ctx, owner(), imageRequest())
	require.NoError(t, err)

	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.NoError(t, err)
	require.Equal(t, ScanClean, asset.ScanStatus)
	require.True(t, asset.Referenceable())
	require.Equal(t, 1, scanner.calls)
	require.Equal(t, UploadCompleted, repo.uploads[upload.ID].Status)
}

// TestCompleteUploadFailsClosedWhenScannerUnavailable is the property that matters:
// an inspection outage must not produce a referenceable asset.
func TestCompleteUploadFailsClosedWhenScannerUnavailable(t *testing.T) {
	repo := newFakeRepo()
	scanner := &fakeScanner{err: errors.New("security down")}
	service := newService(t, repo, scanner)
	ctx := context.Background()

	upload, err := service.CreateUpload(ctx, owner(), imageRequest())
	require.NoError(t, err)

	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.ErrorIs(t, err, ErrSecurityUnavailable)
	require.Empty(t, asset.ID)
	require.Empty(t, repo.assets, "no asset may be created when inspection cannot run")
	require.Equal(t, UploadPending, repo.uploads[upload.ID].Status,
		"the session stays open so the client can retry")
}

func TestCompleteUploadRejectedIsNotReferenceable(t *testing.T) {
	repo := newFakeRepo()
	scanner := &fakeScanner{result: ScanResult{Status: ScanRejected, ReasonCode: "eicar"}}
	service := newService(t, repo, scanner)
	ctx := context.Background()

	upload, err := service.CreateUpload(ctx, owner(), imageRequest())
	require.NoError(t, err)

	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.ErrorIs(t, err, ErrScanRejected)
	require.False(t, asset.Referenceable())
	require.False(t, Referenceable(asset))
}

func TestCompleteUploadRejectsOtherOwner(t *testing.T) {
	service := newService(t, newFakeRepo(), &fakeScanner{result: ScanResult{Status: ScanClean}})
	ctx := context.Background()

	upload, err := service.CreateUpload(ctx, owner(), imageRequest())
	require.NoError(t, err)

	stranger := Actor{UserID: "u2", SiteID: "s1"}
	_, err = service.CompleteUpload(ctx, stranger, upload.ID)
	require.ErrorIs(t, err, ErrPermissionDenied)
}

func TestCompleteUploadRejectsExpiredSession(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}})
	ctx := context.Background()

	upload, err := service.CreateUpload(ctx, owner(), imageRequest())
	require.NoError(t, err)

	// Move the session past its lifetime.
	stale := repo.uploads[upload.ID]
	stale.ExpiresAt = stale.CreatedAt.Add(-time.Minute)
	repo.uploads[upload.ID] = stale

	_, err = service.CompleteUpload(ctx, owner(), upload.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestCompleteUploadTwiceIsRejected(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}})
	ctx := context.Background()

	upload, err := service.CreateUpload(ctx, owner(), imageRequest())
	require.NoError(t, err)

	_, err = service.CompleteUpload(ctx, owner(), upload.ID)
	require.NoError(t, err)

	_, err = service.CompleteUpload(ctx, owner(), upload.ID)
	require.ErrorIs(t, err, ErrAlreadyCompleted)
}

func serviceWithStorage(t *testing.T, repo Repository, scanner Scanner) *Service {
	t.Helper()
	storage, err := NewLocalStorage(t.TempDir())
	require.NoError(t, err)

	service, err := NewService(ServiceConfig{
		Repository: repo,
		Scanner:    scanner,
		Storage:    storage,
		Now:        func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)
	return service
}

func TestStoreContentWritesBytes(t *testing.T) {
	repo := newFakeRepo()
	service := serviceWithStorage(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}})
	ctx := context.Background()

	payload := []byte("PNGDATA")
	req := imageRequest()
	req.Size = int64(len(payload))

	upload, err := service.CreateUpload(ctx, owner(), req)
	require.NoError(t, err)

	stored, err := service.StoreContent(ctx, owner(), upload.ID, bytes.NewReader(payload), int64(len(payload)))
	require.NoError(t, err)
	require.Equal(t, UploadUploaded, stored.Status)

	head, err := service.storage.ReadHead(ctx, upload.StorageKey, HeadSampleSize)
	require.NoError(t, err)
	require.Equal(t, payload, head)
}

func TestStoreContentRejectsWrongSize(t *testing.T) {
	service := serviceWithStorage(t, newFakeRepo(), &fakeScanner{})
	ctx := context.Background()

	upload, err := service.CreateUpload(ctx, owner(), imageRequest())
	require.NoError(t, err)

	_, err = service.StoreContent(ctx, owner(), upload.ID, bytes.NewReader([]byte("x")), 999)
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestStoreContentRejectsOtherOwner(t *testing.T) {
	service := serviceWithStorage(t, newFakeRepo(), &fakeScanner{})
	ctx := context.Background()

	upload, err := service.CreateUpload(ctx, owner(), imageRequest())
	require.NoError(t, err)

	stranger := Actor{UserID: "u2", SiteID: "s1"}
	_, err = service.StoreContent(ctx, stranger, upload.ID, bytes.NewReader([]byte("x")), 1)
	require.ErrorIs(t, err, ErrPermissionDenied)
}

// TestCompleteUploadSendsStoredSample is the point of the storage adapter: inspection
// receives real leading bytes instead of being asked to guess.
func TestCompleteUploadSendsStoredSample(t *testing.T) {
	repo := newFakeRepo()
	scanner := &capturingScanner{result: ScanResult{Status: ScanClean}}
	service := serviceWithStorage(t, repo, scanner)
	ctx := context.Background()

	payload := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	req := imageRequest()
	req.Size = int64(len(payload))

	upload, err := service.CreateUpload(ctx, owner(), req)
	require.NoError(t, err)

	_, err = service.StoreContent(ctx, owner(), upload.ID, bytes.NewReader(payload), int64(len(payload)))
	require.NoError(t, err)

	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.NoError(t, err)
	require.True(t, asset.Referenceable())
	require.Equal(t, payload, scanner.last.Head, "inspection must receive the stored sample")
}

func TestCompleteUploadWithoutStorageAsksForReview(t *testing.T) {
	repo := newFakeRepo()
	scanner := &capturingScanner{result: ScanResult{Status: ScanNeedsManualReview}}
	service := newService(t, repo, scanner)
	ctx := context.Background()

	upload, err := service.CreateUpload(ctx, owner(), imageRequest())
	require.NoError(t, err)

	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.NoError(t, err)
	require.False(t, asset.Referenceable())
	require.Empty(t, scanner.last.Head, "no storage means no sample")
}

type capturingScanner struct {
	result ScanResult
	last   ScanInput
}

func (c *capturingScanner) Inspect(_ context.Context, in ScanInput) (ScanResult, error) {
	c.last = in
	return c.result, nil
}

// TestOpenAssetRefusesUncleanObjects is the property that matters: a file that failed
// inspection must not be downloadable, not even by the account that uploaded it.
func TestOpenAssetRefusesUncleanObjects(t *testing.T) {
	repo := newFakeRepo()
	service := serviceWithStorage(t, repo, &fakeScanner{result: ScanResult{Status: ScanRejected}})
	ctx := context.Background()

	payload := []byte("MZ\x90\x00")
	req := imageRequest()
	req.Size = int64(len(payload))

	upload, err := service.CreateUpload(ctx, owner(), req)
	require.NoError(t, err)
	_, err = service.StoreContent(ctx, owner(), upload.ID, bytes.NewReader(payload), int64(len(payload)))
	require.NoError(t, err)

	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.ErrorIs(t, err, ErrScanRejected)

	_, _, err = service.OpenAsset(ctx, owner(), asset.ID)
	require.ErrorIs(t, err, ErrNotFound, "a rejected asset is not downloadable")
}

func TestOpenAssetReturnsBytes(t *testing.T) {
	repo := newFakeRepo()
	service := serviceWithStorage(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}})
	ctx := context.Background()

	payload := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	req := imageRequest()
	req.Size = int64(len(payload))

	upload, err := service.CreateUpload(ctx, owner(), req)
	require.NoError(t, err)
	_, err = service.StoreContent(ctx, owner(), upload.ID, bytes.NewReader(payload), int64(len(payload)))
	require.NoError(t, err)
	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.NoError(t, err)

	found, reader, err := service.OpenAsset(ctx, owner(), asset.ID)
	require.NoError(t, err)
	defer reader.Close()

	read, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.Equal(t, payload, read)
	require.Equal(t, "image/png", found.MIME)
}

func TestOpenAssetIsSiteScoped(t *testing.T) {
	repo := newFakeRepo()
	service := serviceWithStorage(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}})
	ctx := context.Background()

	payload := []byte{0x89, 0x50, 0x4E, 0x47}
	req := imageRequest()
	req.Size = int64(len(payload))

	upload, err := service.CreateUpload(ctx, owner(), req)
	require.NoError(t, err)
	_, err = service.StoreContent(ctx, owner(), upload.ID, bytes.NewReader(payload), int64(len(payload)))
	require.NoError(t, err)
	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.NoError(t, err)

	outsider := Actor{UserID: "u1", SiteID: "other-site"}
	_, _, err = service.OpenAsset(ctx, outsider, asset.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

// --- per purpose storage routing -------------------------------------------

// recordingStorage remembers which adapter received each byte operation, which is how
// the routing tests prove that the right scope handled the call.
type recordingStorage struct {
	name    string
	puts    int
	heads   int
	opens   int
	deletes int
	lastKey string
}

func (r *recordingStorage) Put(_ context.Context, key string, reader io.Reader, size int64) error {
	r.puts++
	r.lastKey = key
	_, err := io.Copy(io.Discard, io.LimitReader(reader, size))
	return err
}

func (r *recordingStorage) ReadHead(_ context.Context, key string, _ int) ([]byte, error) {
	r.heads++
	r.lastKey = key
	return []byte{0x89, 0x50, 0x4E, 0x47}, nil
}

func (r *recordingStorage) Open(_ context.Context, key string) (io.ReadCloser, error) {
	r.opens++
	r.lastKey = key
	return io.NopCloser(strings.NewReader("DATA")), nil
}

func (r *recordingStorage) Delete(_ context.Context, key string) error {
	r.deletes++
	r.lastKey = key
	return nil
}

func serviceWithStorages(
	t *testing.T,
	repo Repository,
	scanner Scanner,
	global Storage,
	overrides map[Purpose]Storage,
) *Service {
	t.Helper()
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Scanner:    scanner,
		Storage:    global,
		Storages:   overrides,
		Now:        func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)
	return service
}

// createAndUpload opens a session and stores its bytes, so the routing tests can
// observe which adapter the upload path used.
func createAndUpload(t *testing.T, service *Service, purpose Purpose) Upload {
	t.Helper()
	mime := "image/png"
	if purpose == PurposeAttachment {
		mime = "application/pdf"
	}
	payload := []byte("DATA")
	upload, err := service.CreateUpload(context.Background(), owner(), UploadRequest{
		FileName:     "object.bin",
		DeclaredMIME: mime,
		Size:         int64(len(payload)),
		Purpose:      purpose,
	})
	require.NoError(t, err)
	_, err = service.StoreContent(context.Background(), owner(), upload.ID, bytes.NewReader(payload), int64(len(payload)))
	require.NoError(t, err)
	return upload
}

func TestServiceRoutesStorageByPurpose(t *testing.T) {
	repo := newFakeRepo()
	global := &recordingStorage{name: "global"}
	contentStore := &recordingStorage{name: "content"}
	siteStore := &recordingStorage{name: "site"}
	service := serviceWithStorages(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}},
		global, map[Purpose]Storage{
			PurposeContent: contentStore,
			PurposeSite:    siteStore,
		})
	ctx := context.Background()

	contentUpload := createAndUpload(t, service, PurposeContent)
	siteUpload := createAndUpload(t, service, PurposeSite)
	avatarUpload := createAndUpload(t, service, PurposeAvatar)

	require.Equal(t, 1, contentStore.puts, "content uploads go to the content adapter")
	require.Equal(t, 1, siteStore.puts, "site uploads go to the site adapter")
	require.Equal(t, 1, global.puts, "a purpose without an override falls back to the global adapter")
	require.Zero(t, contentStore.heads)
	require.Zero(t, siteStore.heads)

	// Completion reads the leading bytes from the same adapter the upload wrote to.
	_, err := service.CompleteUpload(ctx, owner(), contentUpload.ID)
	require.NoError(t, err)
	_, err = service.CompleteUpload(ctx, owner(), siteUpload.ID)
	require.NoError(t, err)
	_, err = service.CompleteUpload(ctx, owner(), avatarUpload.ID)
	require.NoError(t, err)

	require.Equal(t, 1, contentStore.heads)
	require.Equal(t, 1, siteStore.heads)
	require.Equal(t, 1, global.heads)
}

func TestOpenAssetUsesRecordedPurpose(t *testing.T) {
	repo := newFakeRepo()
	global := &recordingStorage{name: "global"}
	siteStore := &recordingStorage{name: "site"}
	service := serviceWithStorages(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}},
		global, map[Purpose]Storage{PurposeSite: siteStore})
	ctx := context.Background()

	upload := createAndUpload(t, service, PurposeSite)
	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.NoError(t, err)
	require.Equal(t, PurposeSite, asset.Purpose, "the asset must persist the upload purpose")

	global.opens, siteStore.opens = 0, 0
	_, reader, err := service.OpenAsset(ctx, owner(), asset.ID)
	require.NoError(t, err)
	require.NoError(t, reader.Close())

	require.Equal(t, 1, siteStore.opens, "download must use the adapter recorded on the asset")
	require.Zero(t, global.opens)

	// A row written before per purpose storage existed carries the zero purpose and
	// must keep working through the global adapter.
	legacy := Asset{
		ID: "legacy", SiteID: "s1", OwnerID: "u1", StorageKey: "aa/legacy.png",
		MIME: "image/png", Size: 4, ScanStatus: ScanClean, CreatedAt: time.Now().UTC(),
	}
	repo.assets = append(repo.assets, legacy)
	_, reader, err = service.OpenAsset(ctx, owner(), legacy.ID)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	require.Equal(t, 1, global.opens, "an asset without a purpose falls back to the global adapter")
}

func TestDeleteAssetUsesRecordedPurpose(t *testing.T) {
	repo := newFakeRepo()
	global := &recordingStorage{name: "global"}
	siteStore := &recordingStorage{name: "site"}
	service := serviceWithStorages(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}},
		global, map[Purpose]Storage{PurposeSite: siteStore})
	ctx := context.Background()

	upload := createAndUpload(t, service, PurposeSite)
	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.NoError(t, err)

	// A stranger cannot delete the object, and no adapter is touched.
	stranger := Actor{UserID: "u2", SiteID: "s1"}
	require.ErrorIs(t, service.DeleteAsset(ctx, stranger, asset.ID), ErrPermissionDenied)
	require.Zero(t, siteStore.deletes)
	require.Zero(t, global.deletes)

	require.NoError(t, service.DeleteAsset(ctx, owner(), asset.ID))
	require.Equal(t, 1+len(VariantWidths), siteStore.deletes,
		"delete must clear the three image variants and the original through the recorded adapter")
	require.Zero(t, global.deletes)

	_, err = repo.FindAsset(ctx, "s1", asset.ID)
	require.ErrorIs(t, err, ErrNotFound, "the record is removed after the object")
}

func TestStorageRoutingFallsBackWhenPurposeMissing(t *testing.T) {
	repo := newFakeRepo()
	global := &recordingStorage{name: "global"}
	service := serviceWithStorages(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}}, global, nil)

	upload := createAndUpload(t, service, PurposeSite)
	require.Equal(t, 1, global.puts, "no overrides means every purpose uses the global adapter")

	asset, err := service.CompleteUpload(context.Background(), owner(), upload.ID)
	require.NoError(t, err)
	require.Equal(t, PurposeSite, asset.Purpose)

	_, reader, err := service.OpenAsset(context.Background(), owner(), asset.ID)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	require.Equal(t, 1, global.opens)
}

// seedAsset stores an asset the way a completed upload would leave it behind.
func seedAsset(
	t *testing.T,
	repo *fakeRepo,
	siteID string,
	purpose Purpose,
	status ScanStatus,
	createdAt time.Time,
) Asset {
	t.Helper()

	asset, err := repo.InsertAsset(context.Background(), Asset{
		SiteID:     siteID,
		OwnerID:    "u1",
		FileName:   "photo.png",
		StorageKey: fmt.Sprintf("ab/%d.png", len(repo.assets)),
		MIME:       "image/png",
		Size:       10,
		ScanStatus: status,
		Purpose:    purpose,
		CreatedAt:  createdAt,
	})
	require.NoError(t, err)
	return asset
}

// TestListAssetsNormalisesLimit pins the page size rules: an absent or out of range
// limit falls back to the default, and a value inside the bounds is honoured.
func TestListAssetsNormalisesLimit(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{})
	ctx := context.Background()

	for _, limit := range []int{0, -5, 500} {
		_, _, err := service.ListAssets(ctx, owner(), AssetFilter{}, limit, page.Cursor{})
		require.NoError(t, err, "limit %d", limit)
		require.Equal(t, DefaultListLimit, repo.lastList().limit, "limit %d must fall back", limit)
	}

	_, _, err := service.ListAssets(ctx, owner(), AssetFilter{}, MaxListLimit, page.Cursor{})
	require.NoError(t, err)
	require.Equal(t, MaxListLimit, repo.lastList().limit, "the ceiling itself is a valid page size")
}

// TestListAssetsRejectsUnknownFilters is the property that matters: a filter value the
// server does not know must be refused, never quietly ignored, because an ignored
// filter returns the whole library under the label of a narrow one.
func TestListAssetsRejectsUnknownFilters(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{})
	ctx := context.Background()

	_, _, err := service.ListAssets(ctx, owner(), AssetFilter{Purpose: Purpose("video")}, 0, page.Cursor{})
	require.ErrorIs(t, err, ErrInvalidInput)

	_, _, err = service.ListAssets(ctx, owner(), AssetFilter{ScanStatus: ScanStatus("infected")}, 0, page.Cursor{})
	require.ErrorIs(t, err, ErrInvalidInput)

	require.Empty(t, repo.listCalls, "a refused filter must not reach the repository")
}

func TestListAssetsScopesToActorSite(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{})
	ctx := context.Background()
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

	mine := seedAsset(t, repo, "s1", PurposeContent, ScanClean, now)
	seedAsset(t, repo, "s2", PurposeContent, ScanClean, now)

	assets, _, err := service.ListAssets(ctx, owner(), AssetFilter{}, 0, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, assets, 1, "another site's assets must never appear")
	require.Equal(t, mine.ID, assets[0].ID)
	require.Equal(t, "s1", repo.lastList().siteID, "the scope comes from the token, not the caller")
}

func TestListAssetsMemberSeesOnlyTheirOwnAssets(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{})
	ctx := context.Background()

	_, _, err := service.ListAssets(ctx, member(), AssetFilter{}, 0, page.Cursor{})
	require.NoError(t, err)
	require.Equal(t, "u1", repo.lastList().filter.OwnerID,
		"a member may only list their own uploads")

	_, _, err = service.ListAssets(ctx, owner(), AssetFilter{}, 0, page.Cursor{})
	require.NoError(t, err)
	require.Empty(t, repo.lastList().filter.OwnerID,
		"an editor lists the site wide library")
}

func TestListAssetsAppliesFilters(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{})
	ctx := context.Background()
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

	content := seedAsset(t, repo, "s1", PurposeContent, ScanClean, now)
	avatar := seedAsset(t, repo, "s1", PurposeAvatar, ScanRejected, now.Add(-time.Hour))

	byPurpose, _, err := service.ListAssets(ctx, owner(), AssetFilter{Purpose: PurposeAvatar}, 0, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byPurpose, 1)
	require.Equal(t, avatar.ID, byPurpose[0].ID)
	require.Equal(t, AssetFilter{Purpose: PurposeAvatar}, repo.lastList().filter)

	byStatus, _, err := service.ListAssets(ctx, owner(), AssetFilter{ScanStatus: ScanClean}, 0, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byStatus, 1)
	require.Equal(t, content.ID, byStatus[0].ID)

	both, _, err := service.ListAssets(ctx, owner(),
		AssetFilter{Purpose: PurposeContent, ScanStatus: ScanRejected}, 0, page.Cursor{})
	require.NoError(t, err)
	require.Empty(t, both, "the dimensions combine with AND")
}

// TestListAssetsIssuesCursorOnlyOnFullPage keeps a client from asking for an empty
// page: the cursor names the last row of a full page and is withheld otherwise.
func TestListAssetsIssuesCursorOnlyOnFullPage(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{})
	ctx := context.Background()
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

	first := seedAsset(t, repo, "s1", PurposeContent, ScanClean, now)
	seedAsset(t, repo, "s1", PurposeContent, ScanClean, now.Add(-time.Minute))
	seedAsset(t, repo, "s1", PurposeContent, ScanClean, now.Add(-2*time.Minute))

	page1, next, err := service.ListAssets(ctx, owner(), AssetFilter{}, 2, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, page1, 2)
	require.NotEmpty(t, next)

	decoded, err := page.Decode(next)
	require.NoError(t, err)
	require.Equal(t, page1[len(page1)-1].ID, decoded.ID)
	require.Equal(t, page1[len(page1)-1].CreatedAt.UTC().Format(time.RFC3339Nano), decoded.Key)

	all, last, err := service.ListAssets(ctx, owner(), AssetFilter{}, 5, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, all, 3)
	require.Equal(t, first.ID, all[0].ID, "the newest asset comes first")
	require.Empty(t, last, "a short page is the end of the listing")
}

// TestListAssetsRejectsUnusableCursor is what keeps an infinite scroll terminating:
// a cursor whose sort key is not a timestamp is a client error, not a fresh start.
func TestListAssetsRejectsUnusableCursor(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{})

	_, _, err := service.ListAssets(context.Background(), owner(), AssetFilter{}, 0,
		page.Cursor{Key: "not-a-timestamp", ID: "a1"})
	require.ErrorIs(t, err, page.ErrInvalidCursor)
	require.Empty(t, repo.listCalls)
}

func TestListAssetsPassesCursorThrough(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{})
	cursor := page.Cursor{Key: time.Date(2026, 10, 18, 11, 0, 0, 0, time.UTC).Format(time.RFC3339Nano), ID: "a1"}

	_, _, err := service.ListAssets(context.Background(), owner(), AssetFilter{}, 0, cursor)
	require.NoError(t, err)
	require.Equal(t, cursor, repo.lastList().after)
}
