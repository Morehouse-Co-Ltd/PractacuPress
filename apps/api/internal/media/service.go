package media

import (
	"io"
	"context"
	"errors"
	"time"
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
}

// Service implements the two phase upload flow.
type Service struct {
	repo    Repository
	scanner Scanner
	storage Storage
	now     func() time.Time
}

// ServiceConfig configures a Service.
type ServiceConfig struct {
	Repository Repository
	Scanner    Scanner
	// Storage is optional. Without it the API cannot accept bytes, so completion can
	// only ask for manual review.
	Storage Storage
	Now     func() time.Time
}

// NewService builds a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Repository == nil {
		return nil, errors.New("media: repository is required")
	}
	if cfg.Scanner == nil {
		return nil, errors.New("media: scanner is required")
	}
	service := &Service{repo: cfg.Repository, scanner: cfg.Scanner, storage: cfg.Storage, now: cfg.Now}
	if service.now == nil {
		service.now = func() time.Time { return time.Now().UTC() }
	}
	return service, nil
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
	if s.storage == nil {
		return Upload{}, ErrStorageMissing
	}
	if size != upload.Size {
		return Upload{}, ErrInvalidInput
	}

	if putErr := s.storage.Put(ctx, upload.StorageKey, body, upload.Size); putErr != nil {
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
	// clean just because it could not look at it.
	var head []byte
	if s.storage != nil {
		sample, readErr := s.storage.ReadHead(ctx, upload.StorageKey, HeadSampleSize)
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
	asset, err := s.repo.FindAsset(ctx, actor.SiteID, assetID)
	if err != nil {
		return Asset{}, nil, err
	}
	if !asset.Referenceable() {
		return Asset{}, nil, ErrNotFound
	}
	if s.storage == nil {
		return Asset{}, nil, ErrStorageMissing
	}

	reader, err := s.storage.Open(ctx, asset.StorageKey)
	if err != nil {
		if errors.Is(err, ErrStorageObjectMissing) {
			return Asset{}, nil, ErrNotFound
		}
		return Asset{}, nil, err
	}
	return asset, reader, nil
}
// Referenceable reports whether an asset may be linked from content.
//
// It exists so callers ask a question rather than inspecting the status themselves:
// a new scan state must default to "not referenceable" in one place.
func Referenceable(asset Asset) bool { return asset.ScanStatus == ScanClean }
