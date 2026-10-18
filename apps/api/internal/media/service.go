package media

import (
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
	MarkUploadCompleted(ctx context.Context, uploadID string, at time.Time) error
	InsertAsset(ctx context.Context, asset Asset) (Asset, error)
}

// Service implements the two phase upload flow.
type Service struct {
	repo    Repository
	scanner Scanner
	now     func() time.Time
}

// ServiceConfig configures a Service.
type ServiceConfig struct {
	Repository Repository
	Scanner    Scanner
	Now        func() time.Time
}

// NewService builds a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Repository == nil {
		return nil, errors.New("media: repository is required")
	}
	if cfg.Scanner == nil {
		return nil, errors.New("media: scanner is required")
	}
	service := &Service{repo: cfg.Repository, scanner: cfg.Scanner, now: cfg.Now}
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

	result, err := s.scanner.Inspect(ctx, ScanInput{
		FileName:     upload.FileName,
		DeclaredMIME: upload.DeclaredMIME,
		Size:         upload.Size,
		StorageKey:   upload.StorageKey,
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

// Referenceable reports whether an asset may be linked from content.
//
// It exists so callers ask a question rather than inspecting the status themselves:
// a new scan state must default to "not referenceable" in one place.
func Referenceable(asset Asset) bool { return asset.ScanStatus == ScanClean }
