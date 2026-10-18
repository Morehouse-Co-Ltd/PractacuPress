// Package mediastore implements the media persistence port with Ent.
package mediastore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/media"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/mediaasset"
	"github.com/practacu/practacu-press/apps/api/ent/mediaupload"
)

// Store is the Ent backed implementation of media.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ media.Repository = (*Store)(nil)

// InsertUpload opens an upload session.
func (s *Store) InsertUpload(ctx context.Context, upload media.Upload) (media.Upload, error) {
	created, err := s.client.MediaUpload.Create().
		SetSiteID(upload.SiteID).
		SetOwnerID(upload.OwnerID).
		SetFileName(upload.FileName).
		SetDeclaredMime(upload.DeclaredMIME).
		SetSize(upload.Size).
		SetPurpose(string(upload.Purpose)).
		SetStorageKey(upload.StorageKey).
		SetStatus(string(media.UploadPending)).
		SetExpiresAt(upload.ExpiresAt).
		Save(ctx)
	if err != nil {
		return media.Upload{}, err
	}
	return toUpload(created), nil
}

// FindUpload loads a session inside a site scope.
func (s *Store) FindUpload(ctx context.Context, siteID, uploadID string) (media.Upload, error) {
	row, err := s.client.MediaUpload.Query().
		Where(mediaupload.IDEQ(uploadID), mediaupload.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return media.Upload{}, media.ErrNotFound
		}
		return media.Upload{}, err
	}
	return toUpload(row), nil
}

// MarkUploadCompleted closes a session. Marking twice is a no-op.
func (s *Store) MarkUploadCompleted(ctx context.Context, uploadID string, at time.Time) error {
	affected, err := s.client.MediaUpload.Update().
		Where(mediaupload.IDEQ(uploadID), mediaupload.StatusNEQ(string(media.UploadCompleted))).
		SetStatus(string(media.UploadCompleted)).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return err
	}
	if affected == 0 {
		// Either the row is gone or it is already completed; the second case is the
		// caller's business, so only a missing row is reported here.
		exists, existErr := s.client.MediaUpload.Query().Where(mediaupload.IDEQ(uploadID)).Exist(ctx)
		if existErr != nil {
			return existErr
		}
		if !exists {
			return media.ErrNotFound
		}
	}
	return nil
}

// InsertAsset stores an inspected object.
func (s *Store) InsertAsset(ctx context.Context, asset media.Asset) (media.Asset, error) {
	builder := s.client.MediaAsset.Create().
		SetSiteID(asset.SiteID).
		SetOwnerID(asset.OwnerID).
		SetStorageKey(asset.StorageKey).
		SetMimeType(asset.MIME).
		SetSize(asset.Size).
		SetScanStatus(string(asset.ScanStatus)).
		SetCreatedAt(asset.CreatedAt).
		SetUpdatedAt(asset.CreatedAt)

	if asset.ReasonCode != "" {
		builder.SetScanReason(asset.ReasonCode)
	}

	created, err := builder.Save(ctx)
	if err != nil {
		return media.Asset{}, err
	}
	return toAsset(created), nil
}

func toUpload(row *entgen.MediaUpload) media.Upload {
	return media.Upload{
		ID:           row.ID,
		SiteID:       row.SiteID,
		OwnerID:      row.OwnerID,
		FileName:     row.FileName,
		DeclaredMIME: row.DeclaredMime,
		Size:         row.Size,
		Purpose:      media.Purpose(row.Purpose),
		StorageKey:   row.StorageKey,
		Status:       media.UploadStatus(row.Status),
		ExpiresAt:    row.ExpiresAt,
		CreatedAt:    row.CreatedAt,
	}
}

func toAsset(row *entgen.MediaAsset) media.Asset {
	asset := media.Asset{
		ID:         row.ID,
		SiteID:     row.SiteID,
		OwnerID:    row.OwnerID,
		StorageKey: row.StorageKey,
		MIME:       row.MimeType,
		Size:       row.Size,
		ScanStatus: media.ScanStatus(row.ScanStatus),
		CreatedAt:  row.CreatedAt,
	}
	if row.ScanReason != nil {
		asset.ReasonCode = *row.ScanReason
	}
	return asset
}

// keep the predicate import meaningful for future filters.
var _ = mediaasset.ID
