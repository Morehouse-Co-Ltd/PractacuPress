// Package mediastore implements the media persistence port with Ent.
package mediastore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/ent/mediaasset"
	"github.com/practacu/practacu-press/apps/api/ent/mediaquotaguard"
	"github.com/practacu/practacu-press/apps/api/ent/mediaupload"
	entsite "github.com/practacu/practacu-press/apps/api/ent/site"
	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
	"github.com/practacu/practacu-press/apps/api/internal/media"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
)

// Store is the Ent backed implementation of media.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ media.Repository = (*Store)(nil)
var _ media.QuotaOverrideReader = (*Store)(nil)
var _ media.GarbageCatalog = (*Store)(nil)

// MediaQuotaOverrides returns the explicit site and active membership limits.
// Nil values deliberately remain nil so the media service can apply deployment
// defaults; zero is retained as an explicit unlimited override.
func (s *Store) MediaQuotaOverrides(ctx context.Context, siteID, userID string) (media.QuotaOverrides, error) {
	siteRow, err := s.client.Site.Get(ctx, siteID)
	if err != nil {
		if entgen.IsNotFound(err) {
			return media.QuotaOverrides{}, media.ErrNotFound
		}
		return media.QuotaOverrides{}, err
	}

	member, err := s.client.SiteMember.Query().
		Where(
			sitemember.SiteIDEQ(siteID),
			sitemember.UserIDEQ(userID),
			sitemember.StatusEQ(site.MemberStatusActive),
		).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return media.QuotaOverrides{}, media.ErrPermissionDenied
		}
		return media.QuotaOverrides{}, err
	}
	return media.QuotaOverrides{UserBytes: member.MediaQuotaBytes, SiteBytes: siteRow.MediaQuotaBytes}, nil
}

// InsertUpload opens an upload session.
func (s *Store) InsertUpload(ctx context.Context, upload media.Upload) (media.Upload, error) {
	return insertUpload(ctx, s.client, upload)
}

func insertUpload(ctx context.Context, client *entgen.Client, upload media.Upload) (media.Upload, error) {
	created, err := client.MediaUpload.Create().
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

// InsertUploadWithinQuota serializes reservations at the site row before reading
// usage, so concurrent requests and API replicas observe committed reservations.
func (s *Store) InsertUploadWithinQuota(
	ctx context.Context,
	upload media.Upload,
	userLimitBytes, siteLimitBytes int64,
) (media.Upload, error) {
	if upload.Size <= 0 || userLimitBytes < 0 || siteLimitBytes < 0 {
		return media.Upload{}, media.ErrInvalidInput
	}

	tx, err := s.client.Tx(ctx)
	if err != nil {
		return media.Upload{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	exists, err := tx.Site.Query().Where(entsite.IDEQ(upload.SiteID)).Exist(ctx)
	if err != nil {
		return media.Upload{}, err
	}
	if !exists {
		return media.Upload{}, media.ErrNotFound
	}

	if err := tx.MediaQuotaGuard.Create().
		SetSiteID(upload.SiteID).
		OnConflictColumns(mediaquotaguard.FieldSiteID).
		Ignore().Exec(ctx); err != nil {
		return media.Upload{}, err
	}
	locked, err := tx.MediaQuotaGuard.Update().
		Where(mediaquotaguard.SiteIDEQ(upload.SiteID)).
		AddSerial(1).
		Save(ctx)
	if err != nil {
		return media.Upload{}, err
	}
	if locked != 1 {
		return media.Upload{}, media.ErrNotFound
	}

	assetUsage, err := sumUsage(ctx, func(ctx context.Context, v any) error {
		return tx.MediaAsset.Query().Where(mediaasset.SiteIDEQ(upload.SiteID)).
			Aggregate(entgen.As(entgen.Sum(mediaasset.FieldSize), "total")).Scan(ctx, v)
	})
	if err != nil {
		return media.Upload{}, err
	}
	userAssetUsage, err := sumUsage(ctx, func(ctx context.Context, v any) error {
		return tx.MediaAsset.Query().Where(mediaasset.SiteIDEQ(upload.SiteID), mediaasset.OwnerIDEQ(upload.OwnerID)).
			Aggregate(entgen.As(entgen.Sum(mediaasset.FieldSize), "total")).Scan(ctx, v)
	})
	if err != nil {
		return media.Upload{}, err
	}
	now := time.Now().UTC()
	activeUploads := mediaupload.Or(
		mediaupload.StatusEQ(string(media.UploadPending)),
		mediaupload.StatusEQ(string(media.UploadUploaded)),
	)
	siteUploadUsage, err := sumUsage(ctx, func(ctx context.Context, v any) error {
		return tx.MediaUpload.Query().Where(mediaupload.SiteIDEQ(upload.SiteID), mediaupload.ExpiresAtGT(now), activeUploads).
			Aggregate(entgen.As(entgen.Sum(mediaupload.FieldSize), "total")).Scan(ctx, v)
	})
	if err != nil {
		return media.Upload{}, err
	}
	userUploadUsage, err := sumUsage(ctx, func(ctx context.Context, v any) error {
		return tx.MediaUpload.Query().Where(
			mediaupload.SiteIDEQ(upload.SiteID),
			mediaupload.OwnerIDEQ(upload.OwnerID),
			mediaupload.ExpiresAtGT(now),
			activeUploads,
		).Aggregate(entgen.As(entgen.Sum(mediaupload.FieldSize), "total")).Scan(ctx, v)
	})
	if err != nil {
		return media.Upload{}, err
	}

	if exceedsQuota(userAssetUsage, userUploadUsage, upload.Size, userLimitBytes) ||
		exceedsQuota(assetUsage, siteUploadUsage, upload.Size, siteLimitBytes) {
		return media.Upload{}, media.ErrQuotaExceeded
	}

	created, err := insertUpload(ctx, tx.Client(), upload)
	if err != nil {
		return media.Upload{}, err
	}
	if err := tx.Commit(); err != nil {
		return media.Upload{}, err
	}
	committed = true
	return created, nil
}

func sumUsage(ctx context.Context, scan func(context.Context, any) error) (int64, error) {
	var rows []struct {
		Total int64 `json:"total"`
	}
	if err := scan(ctx, &rows); err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	return rows[0].Total, nil
}

func exceedsQuota(used, reserved, requested, limit int64) bool {
	if limit == 0 {
		return false
	}
	if used >= limit {
		return true
	}
	remaining := limit - used
	if reserved >= remaining {
		return true
	}
	return requested > remaining-reserved
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

// AllAssets returns every asset row across every site.
//
// It exists for offline garbage collection only, which is why it is not part of
// media.Repository: no request handler should be able to enumerate all tenants.
func (s *Store) AllAssets(ctx context.Context) ([]media.Asset, error) {
	rows, err := s.client.MediaAsset.Query().
		Order(entgen.Asc(mediaasset.FieldCreatedAt), entgen.Asc(mediaasset.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	assets := make([]media.Asset, 0, len(rows))
	for _, row := range rows {
		assets = append(assets, toAsset(row))
	}
	return assets, nil
}

// AllUploads returns every upload session across every site.
func (s *Store) AllUploads(ctx context.Context) ([]media.Upload, error) {
	rows, err := s.client.MediaUpload.Query().
		Order(entgen.Asc(mediaupload.FieldCreatedAt), entgen.Asc(mediaupload.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	uploads := make([]media.Upload, 0, len(rows))
	for _, row := range rows {
		uploads = append(uploads, toUpload(row))
	}
	return uploads, nil
}

// MarkUploadExpired closes an abandoned session.
//
// A row that already moved on is left untouched, so a concurrent completion is never
// overwritten by a collector that read the row a moment earlier.
func (s *Store) MarkUploadExpired(ctx context.Context, uploadID string, at time.Time) error {
	_, err := s.client.MediaUpload.Update().
		Where(
			mediaupload.IDEQ(uploadID),
			mediaupload.StatusIn(string(media.UploadPending), string(media.UploadUploaded)),
		).
		SetStatus(string(media.UploadExpired)).
		SetUpdatedAt(at).
		Save(ctx)
	return err
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
