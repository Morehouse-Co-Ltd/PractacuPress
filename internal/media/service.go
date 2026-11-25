package media

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
)

// ScanInput is what upload inspection looks at.
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
// It is a narrow port so this package does not depend on the scanner implementation,
// and so tests can make inspection fail on demand.
type Scanner interface {
	Inspect(ctx context.Context, in ScanInput) (ScanResult, error)
}

// PublishedReferenceChecker answers whether an asset is referenced by at least one
// published content item of the site.
//
// It is what lets an article image load for a logged-out visitor without exposing
// every upload of the site: a content purpose asset only becomes anonymously readable
// once a published revision references it. The implementation lives in the content
// store; nil means "nothing is published", the safe default.
type PublishedReferenceChecker interface {
	PublishedAssetReference(ctx context.Context, siteID, assetID string) (bool, error)
}

// DesignReferenceChecker reports whether a site's saved page-builder design mentions
// the asset. A content asset used only by a page block is not in any article body,
// so the published rule above cannot see it; this is the second chance.
type DesignReferenceChecker interface {
	DesignAssetReference(ctx context.Context, siteID, assetID string) (bool, error)
}

// AssetUsageChecker reports whether any content item still references an asset,
// published or not.
//
// The read path only asks about published items, because that is what makes an image
// public. A delete has to ask about every item: an image embedded in a draft is just as
// load bearing as one in a published article, and removing it there is a silent
// breakage - nothing errors, the author only finds out when the draft goes live.
type AssetUsageChecker interface {
	// AssetInUse reports whether a content item of siteID mentions the asset id or its
	// storage key.
	AssetInUse(ctx context.Context, siteID, assetID, storageKey string) (bool, error)
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

// StorageResolver resolves the adapter for a purpose at request time. The runtime
// storage manager implements it, so a strategy switch is visible to the next byte
// without rebuilding the media service.
type StorageResolver interface {
	StorageFor(purpose Purpose) Storage
}

// Service implements the two phase upload flow.
type Service struct {
	repo          Repository
	quotaRepo     QuotaReservationRepository
	quota         QuotaOverrideReader
	quotaDefaults QuotaDefaults
	settings      SettingsReader
	scanner       Scanner
	storage       Storage
	storages      map[Purpose]Storage
	resolver      StorageResolver
	references    PublishedReferenceChecker
	design        DesignReferenceChecker
	now           func() time.Time
	// usage is the delete guard. It answers "does any content item still point at this
	// asset", which the read-path checkers cannot: they only look at published items.
	usage AssetUsageChecker
	// derivativeLocks serialises variant generation per object key. It is a map rather
	// than a single lock so two different images do not wait for each other, and it is
	// keyed by the derived key because that is the object being written. Entries are
	// reference counted and removed when the last waiter leaves, so a long-lived
	// process does not accumulate one mutex per asset it ever served.
	derivativeLocksMu sync.Mutex
	derivativeLocks   map[string]*derivativeLock
	// derivativeSlots bounds how many images are decoded at once. A decoder holds the
	// whole bitmap in memory, so without a global ceiling a burst of first requests for
	// different images could exhaust the process even though each one is small on disk.
	derivativeSlots chan struct{}
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
	// Resolver, when set, wins over Storage and Storages: it is the runtime
	// switching path. The fields above remain for the CLI and tests.
	Resolver StorageResolver
	// References lets the read path serve a content image anonymously once it is
	// referenced by published content. Nil denies that case altogether.
	References PublishedReferenceChecker
	// Design lets a content image referenced only by the page builder load for an
	// anonymous visitor. Nil keeps the previous behaviour.
	Design         DesignReferenceChecker
	QuotaDefaults  QuotaDefaults
	QuotaOverrides QuotaOverrideReader
	// Settings, when set, overrides QuotaDefaults and the upload ceiling with the
	// live storage settings on every request. Tests and CLI paths can omit it.
	Settings SettingsReader
	Now      func() time.Time
	// Usage guards a delete: content that still mentions the asset keeps it alive. Nil
	// falls back to the repository when that can answer the question, and otherwise
	// leaves deletion unrestricted, which is the behaviour before the guard existed.
	Usage AssetUsageChecker
}

// NewService builds a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Repository == nil {
		return nil, errors.New("media: repository is required")
	}
	if cfg.Scanner == nil {
		return nil, errors.New("media: scanner is required")
	}
	if cfg.QuotaDefaults.UserBytes < 0 || cfg.QuotaDefaults.SiteBytes < 0 {
		return nil, errors.New("media: quota limits cannot be negative")
	}
	quotaRepo, hasQuotaRepository := cfg.Repository.(QuotaReservationRepository)
	if (cfg.QuotaDefaults.UserBytes > 0 || cfg.QuotaDefaults.SiteBytes > 0 || cfg.QuotaOverrides != nil) && !hasQuotaRepository {
		return nil, errors.New("media: quota-enabled repository must support atomic reservations")
	}

	storages := make(map[Purpose]Storage, len(cfg.Storages))
	for purpose, storage := range cfg.Storages {
		if storage != nil {
			storages[purpose] = storage
		}
	}

	service := &Service{
		repo:            cfg.Repository,
		quotaRepo:       quotaRepo,
		quota:           cfg.QuotaOverrides,
		quotaDefaults:   cfg.QuotaDefaults,
		settings:        cfg.Settings,
		scanner:         cfg.Scanner,
		storage:         cfg.Storage,
		storages:        storages,
		resolver:        cfg.Resolver,
		references:      cfg.References,
		design:          cfg.Design,
		usage:           usageChecker(cfg),
		now:             cfg.Now,
		derivativeSlots: make(chan struct{}, derivativeConcurrency),
		derivativeLocks: make(map[string]*derivativeLock),
	}
	if service.now == nil {
		service.now = func() time.Time { return time.Now().UTC() }
	}
	return service, nil
}

// usageChecker picks the delete guard.
//
// A repository that can answer the question is used without extra wiring: the shipped
// Ent store owns the content query, and leaving deletes unprotected because a
// deployment missed one configuration line is the worse failure. An explicit cfg.Usage
// still wins, so a store that cannot answer can be wired deliberately.
func usageChecker(cfg ServiceConfig) AssetUsageChecker {
	if cfg.Usage != nil {
		return cfg.Usage
	}
	fromRepository, _ := cfg.Repository.(AssetUsageChecker)
	return fromRepository
}

// storageFor returns the adapter responsible for a purpose.
//
// Every byte path goes through here: upload, inspection and download of a resource
// must agree on the adapter, and the only reliable key is the purpose recorded with
// the upload or asset. Nil means no adapter is configured at all.
func (s *Service) storageFor(purpose Purpose) Storage {
	if s.resolver != nil {
		if storage := s.resolver.StorageFor(purpose); storage != nil {
			return storage
		}
	}
	if storage, ok := s.storages[purpose]; ok {
		return storage
	}
	return s.storage
}

// uploadLimitBytes returns the live single-upload ceiling, or zero when only the
// hard safety ceiling applies.
func (s *Service) uploadLimitBytes() int64 {
	if s.settings == nil {
		return 0
	}
	return s.settings.MediaUploadLimitBytes()
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
	if limit := s.uploadLimitBytes(); limit > 0 && validated.Size > limit {
		return Upload{}, ErrUploadTooLarge
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

	userLimit, siteLimit := s.quotaDefaults.UserBytes, s.quotaDefaults.SiteBytes
	if s.settings != nil {
		userLimit, siteLimit = s.settings.MediaQuotaDefaults()
	}
	if s.quota != nil {
		overrides, err := s.quota.MediaQuotaOverrides(ctx, actor.SiteID, actor.UserID)
		if err != nil {
			return Upload{}, err
		}
		if overrides.UserBytes != nil && *overrides.UserBytes < 0 || overrides.SiteBytes != nil && *overrides.SiteBytes < 0 {
			return Upload{}, ErrInvalidInput
		}
		if overrides.UserBytes != nil {
			userLimit = *overrides.UserBytes
		}
		if overrides.SiteBytes != nil {
			siteLimit = *overrides.SiteBytes
		}
	}
	if userLimit == 0 && siteLimit == 0 {
		return s.repo.InsertUpload(ctx, upload)
	}
	if s.quotaRepo == nil {
		return Upload{}, ErrQuotaUnavailable
	}
	return s.quotaRepo.InsertUploadWithinQuota(ctx, upload, userLimit, siteLimit)
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
	if limit := s.uploadLimitBytes(); limit > 0 && size > limit {
		return Upload{}, ErrUploadTooLarge
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
		FileName:   upload.FileName,
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

// OpenAsset returns a clean asset and a reader over its bytes, after checking that
// this caller may read it.
//
// Editors and above may read the whole library of their site. A member may read their
// own uploads, the site's shared assets (site images and avatars) and a content image
// that appears in published content. Anything else is reported as not found: telling
// a caller that someone else's private attachment exists is itself a disclosure.
func (s *Service) OpenAsset(
	ctx context.Context,
	actor Actor,
	assetID string,
) (Asset, io.ReadCloser, error) {
	return s.openAsset(ctx, actor.SiteID, assetID, func(asset Asset) error {
		if actor.Role.AtLeast(site.RoleEditor) || asset.OwnerID == actor.UserID {
			return nil
		}
		return s.authorizeSharedAsset(ctx, asset)
	})
}

// OpenAssetInSite returns a clean asset scoped to one site, without a caller.
//
// It exists for the anonymous read path: an image embedded in a published article has to
// load for a reader who has no session at all, and the only thing that then identifies
// the tenant is the hostname the request resolved to. Who may read at all is the
// transport's decision (it applies the site's visibility mode); this function only
// enforces the site scope, the scan verdict and the published-reference rule.
func (s *Service) OpenAssetInSite(
	ctx context.Context,
	siteID string,
	assetID string,
) (Asset, io.ReadCloser, error) {
	return s.openAsset(ctx, siteID, assetID, func(asset Asset) error {
		return s.authorizeSharedAsset(ctx, asset)
	})
}

// ValidateAvatar checks that assetID is a clean avatar owned by the caller.
//
// The profile update path calls this before storing avatar_media_id. A member may
// only point their profile at an image they uploaded on this site: another
// member's clearance, another site's asset, a non-avatar purpose and a rejected
// upload all answer the same "not found", so the check is not an existence oracle.
func (s *Service) ValidateAvatar(ctx context.Context, actor Actor, assetID string) error {
	if actor.SiteID == "" || actor.UserID == "" || assetID == "" {
		return ErrNotFound
	}
	asset, err := s.repo.FindAsset(ctx, actor.SiteID, assetID)
	if err != nil {
		return err
	}
	if !asset.Referenceable() || asset.Purpose != PurposeAvatar || asset.OwnerID != actor.UserID {
		return ErrNotFound
	}
	return nil
}

// authorizeSharedAsset is the read rule for assets the caller does not own.
//
// Site images and avatars are public by design. A content asset is only public once a
// published revision references it or the site's saved design embeds it; an attachment
// is never shared. Rejected assets are denied before this point because only
// referenceable (clean) rows reach it.
func (s *Service) authorizeSharedAsset(ctx context.Context, asset Asset) error {
	switch asset.Purpose {
	case PurposeSite, PurposeAvatar:
		return nil
	case PurposeContent:
		if s.references != nil {
			published, err := s.references.PublishedAssetReference(ctx, asset.SiteID, asset.ID)
			if err != nil {
				return err
			}
			if published {
				return nil
			}
		}
		if s.design != nil {
			referenced, err := s.design.DesignAssetReference(ctx, asset.SiteID, asset.ID)
			if err != nil {
				return err
			}
			if referenced {
				return nil
			}
		}
	}
	return ErrNotFound
}

// openAsset loads a referenceable asset and opens its bytes once authorize allows it.
func (s *Service) openAsset(
	ctx context.Context,
	siteID string,
	assetID string,
	authorize func(Asset) error,
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
	if err := authorize(asset); err != nil {
		return Asset{}, nil, err
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

	// A member's library is their own uploads only: the site wide library (which
	// includes other people's drafts and attachments) is an editor view. Narrowing
	// here, in the service, keeps every caller of the port in the same rule.
	if !actor.Role.AtLeast(site.RoleEditor) {
		filter.OwnerID = actor.UserID
	}

	return s.repo.ListAssets(ctx, actor.SiteID, filter, limit, after)
}

// DeleteAsset removes a stored object and its record.
//
// The adapter comes from the asset's persisted purpose, never from a caller supplied
// value: an avatar and an article image may live in different directories or buckets,
// and deleting with the wrong adapter would either miss the object or hit an unrelated
// key. Storage deletes are idempotent, so a missing object still removes the record.
//
// Two guards run before a byte is removed. The caller has to be allowed to dispose of
// the asset (see canDeleteAsset), and content must no longer point at it: an image that
// a published article, a draft or the site design still embeds would break silently,
// because nothing reports a missing media object to the author.
func (s *Service) DeleteAsset(ctx context.Context, actor Actor, assetID string) error {
	asset, err := s.repo.FindAsset(ctx, actor.SiteID, assetID)
	if err != nil {
		return err
	}
	if !actor.canDeleteAsset(asset) {
		return ErrPermissionDenied
	}
	if err := s.ensureUnused(ctx, asset); err != nil {
		return err
	}

	storage := s.storageFor(asset.Purpose)
	if storage == nil {
		return ErrStorageMissing
	}
	// Variants go first: the record is still present, so a retry after a storage
	// failure can find the key again. A variant that outlives its asset is otherwise
	// only reachable through the orphan collector.
	if err := s.deleteDerivatives(ctx, storage, asset); err != nil {
		return err
	}
	if err := storage.Delete(ctx, asset.StorageKey); err != nil {
		return err
	}
	return s.repo.DeleteAsset(ctx, actor.SiteID, assetID)
}

// canDeleteAsset reports whether actor may remove asset.
//
// The uploader can always withdraw what they uploaded - that is their own object, and
// no workflow decision needs to be involved. Disposing of somebody else's upload is a
// different act: the media library is shared, so it takes write_content (the caller is
// trusted with the site's content) and manage_site (they administer the site the object
// belongs to). The two are read from the live capability matrix where the transport
// supplies it, so a group with manage_site revoked cannot do this by holding a role.
func (a Actor) canDeleteAsset(asset Asset) bool {
	if asset.OwnerID != "" && asset.OwnerID == a.UserID {
		return true
	}
	return a.Allows(site.CapabilityWriteContent) && a.Allows(site.CapabilityManageSite)
}

// ensureUnused refuses to delete an object that content or the site design still
// references.
//
// Both checkers are optional and a deployment without them keeps the old behaviour
// rather than turning every delete into an outage; the shipped wiring provides both.
// A checker error is returned as is: "I could not tell" must not become "go ahead".
func (s *Service) ensureUnused(ctx context.Context, asset Asset) error {
	if s.usage != nil {
		inUse, err := s.usage.AssetInUse(ctx, asset.SiteID, asset.ID, asset.StorageKey)
		if err != nil {
			return err
		}
		if inUse {
			return ErrAssetInUse
		}
	}
	if s.design != nil {
		// This is the second opinion, not the primary one: the design document is served
		// from a short lived cache, so a delete that races a just saved design may still
		// slip through. The content query above is the exact check, and it covers the
		// case that breaks pages.
		referenced, err := s.design.DesignAssetReference(ctx, asset.SiteID, asset.ID)
		if err != nil {
			return err
		}
		if referenced {
			return ErrAssetInUse
		}
	}
	return nil
}

// Referenceable reports whether an asset may be linked from content.
//
// It exists so callers ask a question rather than inspecting the status themselves:
// a new scan state must default to "not referenceable" in one place.
func Referenceable(asset Asset) bool { return asset.ScanStatus == ScanClean }
