// Package mediastore implements the media persistence port with Ent.
package mediastore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/media"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"

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

// MarkUploadUploaded records that the bytes arrived.
func (s *Store) MarkUploadUploaded(ctx context.Context, uploadID string, at time.Time) error {
	affected, err := s.client.MediaUpload.Update().
		Where(mediaupload.IDEQ(uploadID), mediaupload.StatusEQ(string(media.UploadPending))).
		SetStatus(string(media.UploadUploaded)).
		SetUpdatedAt(at).
		Save(ctx)
	if err != nil {
		return err
	}
	if affected == 0 {
		exists, existErr := s.client.MediaUpload.Query().Where(mediaupload.IDEQ(uploadID)).Exist(ctx)
		if existErr != nil {
			return existErr
		}
		if !exists {
			return media.ErrNotFound
		}
		return media.ErrAlreadyCompleted
	}
	return nil
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

	// Empty means "caller did not decide" (legacy rows): leave the field out so the
	// schema default applies instead of tripping the purpose validator with "".
	if asset.Purpose != "" {
		builder.SetPurpose(string(asset.Purpose))
	}

	if asset.ReasonCode != "" {
		builder.SetScanReason(asset.ReasonCode)
	}

	created, err := builder.Save(ctx)
	if err != nil {
		return media.Asset{}, err
	}
	return toAsset(created), nil
}

// FindAsset loads an asset inside a site scope.
func (s *Store) FindAsset(ctx context.Context, siteID, assetID string) (media.Asset, error) {
	row, err := s.client.MediaAsset.Query().
		Where(mediaasset.IDEQ(assetID), mediaasset.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return media.Asset{}, media.ErrNotFound
		}
		return media.Asset{}, err
	}
	return toAsset(row), nil
}

// ListAssets returns one page of a site's assets, newest first.
//
// The filters are applied in SQL, before the page size, so a filtered page is still a
// full page and has_more describes the filtered result rather than the whole library.
// Whether another page exists is decided by asking for one row more than the caller
// wants: only when that extra row arrives is a cursor issued, so a client is never sent
// after a page that does not exist.
func (s *Store) ListAssets(
	ctx context.Context,
	siteID string,
	filter media.AssetFilter,
	limit int,
	after page.Cursor,
) ([]media.Asset, string, error) {
	query := s.client.MediaAsset.Query().Where(mediaasset.SiteIDEQ(siteID))

	if filter.Purpose != "" {
		query = query.Where(mediaasset.PurposeEQ(string(filter.Purpose)))
	}
	if filter.ScanStatus != "" {
		query = query.Where(mediaasset.ScanStatusEQ(string(filter.ScanStatus)))
	}
	if filter.OwnerID != "" {
		query = query.Where(mediaasset.OwnerIDEQ(filter.OwnerID))
	}

	// The tie breaker on id is what makes the boundary stable when several rows share a
	// timestamp, which is the normal case for a burst of uploads in the same second.
	if !after.IsZero() {
		boundary, parseErr := time.Parse(time.RFC3339Nano, after.Key)
		if parseErr != nil {
			return nil, "", media.ErrInvalidInput
		}
		query = query.Where(mediaasset.Or(
			mediaasset.CreatedAtLT(boundary),
			mediaasset.And(mediaasset.CreatedAtEQ(boundary), mediaasset.IDLT(after.ID)),
		))
	}

	rows, err := query.
		Order(entgen.Desc(mediaasset.FieldCreatedAt), entgen.Desc(mediaasset.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return nil, "", err
	}

	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}

	assets := make([]media.Asset, 0, len(rows))
	for _, row := range rows {
		assets = append(assets, toAsset(row))
	}

	next := ""
	if hasMore && len(assets) > 0 {
		last := assets[len(assets)-1]
		next = page.Cursor{Key: last.CreatedAt.UTC().Format(time.RFC3339Nano), ID: last.ID}.Encode()
	}
	return assets, next, nil
}

// DeleteAsset removes an asset record inside a site scope.
func (s *Store) DeleteAsset(ctx context.Context, siteID, assetID string) error {
	deleted, err := s.client.MediaAsset.Delete().
		Where(mediaasset.IDEQ(assetID), mediaasset.SiteIDEQ(siteID)).
		Exec(ctx)
	if err != nil {
		return err
	}
	if deleted == 0 {
		return media.ErrNotFound
	}
	return nil
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
	// NULL means the row predates per purpose storage: an empty purpose routes it to
	// the global adapter, which is where its bytes actually are.
	if row.Purpose != nil {
		asset.Purpose = media.Purpose(*row.Purpose)
	}
	if row.ScanReason != nil {
		asset.ReasonCode = *row.ScanReason
	}
	return asset
}
