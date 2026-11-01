package media

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
)

// ScanInput is what the security service inspects.
type ScanInput struct {
	FileName     string
	DeclaredMIME string
	Size         int64
	StorageKey   string
	// Head is the leading bytes of the object, used for magic number checks.
	Head []byte
}

// Scanner inspects an uploaded object.
//
// It is a narrow port so this package does not depend on gRPC, and so tests can make
// inspection fail on demand.
type Scanner interface {
	Inspect(ctx context.Context, in ScanInput) (ScanResult, error)
}

// Repository is the persistence contract for media.
type Repository interface {
	InsertUpload(ctx context.Context, upload Upload) (Upload, error)
	FindUpload(ctx context.Context, siteID, uploadID string) (Upload, error)
	// MarkUploadUploaded records that the bytes arrived and are waiting for inspection.
	MarkUploadUploaded(ctx context.Context, uploadID string, at time.Time) error
	MarkUploadCompleted(ctx context.Context, uploadID string, at time.Time) error
	// FindAsset loads an inspected asset inside a site scope.
	FindAsset(ctx context.Context, siteID, assetID string) (Asset, error)
	InsertAsset(ctx context.Context, asset Asset) (Asset, error)
	// ListAssets returns one page of a site's assets, newest first, plus the cursor for
	// the next page. The cursor is empty when the page is the last one, so the caller
	// never has to guess and never hands out a cursor that yields an empty page.
	ListAssets(
		ctx context.Context,
		siteID string,
		filter AssetFilter,
		limit int,
		after page.Cursor,
	) ([]Asset, string, error)
	// DeleteAsset removes an asset record. Deleting a missing record is reported as
	// ErrNotFound so the caller does not believe a stale object was cleaned up.
	DeleteAsset(ctx context.Context, siteID, assetID string) error
}

// Service implements the two phase upload flow.
type Service struct {
	repo     Repository
	scanner  Scanner
	storage  Storage
	storages map[Purpose]Storage
	now      func() time.Time
}

// ServiceConfig configures a Service.
type ServiceConfig struct {
	Repository Repository
	Scanner    Scanner
	// Storage is optional. Without it the API cannot accept bytes, so completion can
	// only ask for manual review. It is the fallback for every purpose that has no
	// dedicated adapter.
	Storage Storage
	// Storages optionally routes each purpose to its own adapter. A missing entry
	// falls back to Storage, which keeps old deployments unchanged.
	Storages map[Purpose]Storage
	Now      func() time.Time
}

// NewService builds a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Repository == nil {
		return nil, errors.New("media: repository is required")
	}
	if cfg.Scanner == nil {
		return nil, errors.New("media: scanner is required")
	}

	storages := make(map[Purpose]Storage, len(cfg.Storages))
	for purpose, storage := range cfg.Storages {
		if storage != nil {
			storages[purpose] = storage
		}
	}

	service := &Service{
		repo:     cfg.Repository,
		scanner:  cfg.Scanner,
		storage:  cfg.Storage,
		storages: storages,
		now:      cfg.Now,
	}
	if service.now == nil {
		service.now = func() time.Time { return time.Now().UTC() }
	}
	return service, nil
}

// storageFor returns the adapter responsible for a purpose.
//
// Every byte path goes through here: upload, inspection and download of a resource
// must agree on the adapter, and the only reliable key is the purpose recorded with
// the upload or asset. Nil means no adapter is configured at all.
func (s *Service) storageFor(purpose Purpose) Storage {
	if storage, ok := s.storages[purpose]; ok {
		return storage
	}
	return s.storage
}

// CreateUpload opens an upload session.
//
// The session records what the client claims; nothing about that claim is trusted
// later, which is why completion re-inspects the file rather than believing the MIME
// declared here.
func (s *Service) CreateUpload(ctx context.Context, actor Actor, req UploadRequest) (Upload, error) {
	validated, err := ValidateRequest(req)
	if err != nil {
		return Upload{}, err
	}

	now := s.now()
	upload := Upload{
		SiteID:       actor.SiteID,
		OwnerID:      actor.UserID,
		FileName:     validated.FileName,
		DeclaredMIME: validated.DeclaredMIME,
		Size:         validated.Size,
		Purpose:      validated.Purpose,
		StorageKey:   NewStorageKey(validated.FileName),
		Status:       UploadPending,
		ExpiresAt:    now.Add(UploadTTL),
		CreatedAt:    now,
	}

	return s.repo.InsertUpload(ctx, upload)
}

// StoreContent accepts the bytes a client uploads for a session.
//
// The declared size is a hard bound: a client cannot stream more than it promised,
// and a short stream is an error rather than a truncated object.
func (s *Service) StoreContent(
	ctx context.Context,
	actor Actor,
	uploadID string,
	body io.Reader,
	size int64,
) (Upload, error) {
	upload, err := s.repo.FindUpload(ctx, actor.SiteID, uploadID)
	if err != nil {
		return Upload{}, err
	}
	if upload.OwnerID != actor.UserID {
		return Upload{}, ErrPermissionDenied
	}
	if upload.Status == UploadCompleted {
		return Upload{}, ErrAlreadyCompleted
	}
	if upload.Expired(s.now()) {
		return Upload{}, ErrNotFound
	}
	storage := s.storageFor(upload.Purpose)
	if storage == nil {
		return Upload{}, ErrStorageMissing
	}
	if size != upload.Size {
		return Upload{}, ErrInvalidInput
	}

	if putErr := storage.Put(ctx, upload.StorageKey, body, upload.Size); putErr != nil {
		return Upload{}, putErr
	}
	if markErr := s.repo.MarkUploadUploaded(ctx, uploadID, s.now()); markErr != nil {
		return Upload{}, markErr
	}

	upload.Status = UploadUploaded
	return upload, nil
}

// CompleteUpload inspects the stored object and turns it into an asset.
//
// Failures are all fail closed: if inspection cannot run, the session is left as it
// was and no asset is created, so the file can never be referenced from content.
func (s *Service) CompleteUpload(ctx context.Context, actor Actor, uploadID string) (Asset, error) {
	upload, err := s.repo.FindUpload(ctx, actor.SiteID, uploadID)
	if err != nil {
		return Asset{}, err
	}
	if upload.OwnerID != actor.UserID {
		return Asset{}, ErrPermissionDenied
	}
	if upload.Status == UploadCompleted {
		return Asset{}, ErrAlreadyCompleted
	}

	now := s.now()
	if upload.Expired(now) {
		return Asset{}, ErrNotFound
	}

	// Without a sample the service can only ask a human; it never assumes a file is
	// clean just because it could not look at it. The sample is read from the adapter
	// the upload was written to, selected by the session's recorded purpose.
	var head []byte
	if storage := s.storageFor(upload.Purpose); storage != nil {
		sample, readErr := storage.ReadHead(ctx, upload.StorageKey, HeadSampleSize)
		if readErr != nil && !errors.Is(readErr, ErrStorageObjectMissing) {
			return Asset{}, readErr
		}
		head = sample
	}

	result, err := s.scanner.Inspect(ctx, ScanInput{
		FileName:     upload.FileName,
		DeclaredMIME: upload.DeclaredMIME,
		Size:         upload.Size,
		StorageKey:   upload.StorageKey,
		Head:         head,
	})
	if err != nil {
		// The object stays pending; the client may retry completion.
		return Asset{}, ErrSecurityUnavailable
	}

	asset := Asset{
		SiteID:     upload.SiteID,
		OwnerID:    upload.OwnerID,
		StorageKey: upload.StorageKey,
		MIME:       upload.DeclaredMIME,
		Size:       upload.Size,
		ScanStatus: result.Status,
		Purpose:    upload.Purpose,
		ReasonCode: result.ReasonCode,
		CreatedAt:  now,
	}

	stored, err := s.repo.InsertAsset(ctx, asset)
	if err != nil {
		return Asset{}, err
	}

	if err := s.repo.MarkUploadCompleted(ctx, uploadID, now); err != nil {
		return Asset{}, err
	}

	if result.Status == ScanRejected {
		return stored, ErrScanRejected
	}
	return stored, nil
}

// OpenAsset returns a clean asset and a reader over its bytes.
//
// Assets that failed inspection are reported as not found: telling a caller that a
// rejected file exists is already a disclosure.
func (s *Service) OpenAsset(
	ctx context.Context,
	actor Actor,
	assetID string,
) (Asset, io.ReadCloser, error) {
	return s.OpenAssetInSite(ctx, actor.SiteID, assetID)
}

// OpenAssetInSite returns a clean asset scoped to one site, without a caller.
//
// It exists for the anonymous read path: an image embedded in a published article has to
// load for a reader who has no session at all, and the only thing that then identifies
// the tenant is the hostname the request resolved to. Who may read at all is the
// transport's decision (it applies the site's visibility mode); this function only
// enforces the site scope and the scan verdict.
func (s *Service) OpenAssetInSite(
	ctx context.Context,
	siteID string,
	assetID string,
) (Asset, io.ReadCloser, error) {
	if siteID == "" || assetID == "" {
		return Asset{}, nil, ErrNotFound
	}

	asset, err := s.repo.FindAsset(ctx, siteID, assetID)
	if err != nil {
		return Asset{}, nil, err
	}
	if !asset.Referenceable() {
		return Asset{}, nil, ErrNotFound
	}
	storage := s.storageFor(asset.Purpose)
	if storage == nil {
		return Asset{}, nil, ErrStorageMissing
	}

	reader, err := storage.Open(ctx, asset.StorageKey)
	if err != nil {
		if errors.Is(err, ErrStorageObjectMissing) {
			return Asset{}, nil, ErrNotFound
		}
		return Asset{}, nil, err
	}
	return asset, reader, nil
}

// ListAssets returns one page of the site's assets plus the cursor for the next page.
//
// The scope is the actor's site, never a caller supplied one: the token is the only
// tenant boundary, so listing cannot be widened by adding a parameter.
//
// limit is normalised here rather than in the transport so every caller - the HTTP
// handler today, an export tool tomorrow - obeys the same page size rules. A filter
// value outside the known set is rejected instead of silently matching nothing: an
// unknown purpose would otherwise look exactly like an empty library.
func (s *Service) ListAssets(
	ctx context.Context,
	actor Actor,
	filter AssetFilter,
	limit int,
	after page.Cursor,
) ([]Asset, string, error) {
	if err := filter.Validate(); err != nil {
		return nil, "", err
	}
	if limit <= 0 || limit > MaxListLimit {
		limit = DefaultListLimit
	}
	// A cursor whose sort key is not a timestamp cannot be honoured. Reporting it is
	// what stops an infinite scroll loop: falling back to the first page would hand the
	// client the same rows again, forever.
	if !after.IsZero() {
		if _, err := time.Parse(time.RFC3339Nano, after.Key); err != nil {
			return nil, "", page.ErrInvalidCursor
		}
	}

	return s.repo.ListAssets(ctx, actor.SiteID, filter, limit, after)
}

// DeleteAsset removes a stored object and its record.
//
// The adapter comes from the asset's persisted purpose, never from a caller supplied
// value: an avatar and an article image may live in different directories or buckets,
// and deleting with the wrong adapter would either miss the object or hit an unrelated
// key. Storage deletes are idempotent, so a missing object still removes the record.
func (s *Service) DeleteAsset(ctx context.Context, actor Actor, assetID string) error {
	asset, err := s.repo.FindAsset(ctx, actor.SiteID, assetID)
	if err != nil {
		return err
	}
	if asset.OwnerID != actor.UserID {
		return ErrPermissionDenied
	}

	storage := s.storageFor(asset.Purpose)
	if storage == nil {
		return ErrStorageMissing
	}
	if err := storage.Delete(ctx, asset.StorageKey); err != nil {
		return err
	}
	return s.repo.DeleteAsset(ctx, actor.SiteID, assetID)
}

// Referenceable reports whether an asset may be linked from content.
//
// It exists so callers ask a question rather than inspecting the status themselves:
// a new scan state must default to "not referenceable" in one place.
func Referenceable(asset Asset) bool { return asset.ScanStatus == ScanClean }
