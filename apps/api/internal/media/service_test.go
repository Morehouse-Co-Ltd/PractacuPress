package media

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type fakeRepo struct {
	uploads map[string]Upload
	assets  []Asset
	seq     int
}

func newFakeRepo() *fakeRepo { return &fakeRepo{uploads: map[string]Upload{}} }

func (f *fakeRepo) InsertUpload(_ context.Context, upload Upload) (Upload, error) {
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

func (f *fakeRepo) MarkUploadCompleted(_ context.Context, uploadID string, _ time.Time) error {
	upload, ok := f.uploads[uploadID]
	if !ok {
		return ErrNotFound
	}
	upload.Status = UploadCompleted
	f.uploads[uploadID] = upload
	return nil
}

func (f *fakeRepo) InsertAsset(_ context.Context, asset Asset) (Asset, error) {
	f.seq++
	asset.ID = fmt.Sprintf("a%d", f.seq)
	f.assets = append(f.assets, asset)
	return asset, nil
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

func owner() Actor { return Actor{UserID: "u1", SiteID: "s1"} }

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
	scanner := &fakeScanner{err: errors.New("grpc down")}
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
