package media

// garbage.go owns offline cleanup of media objects.
//
// Variants are derived objects with no row of their own; a delete removes them eagerly,
// but a crash, a failed storage call or a bug can still leave one behind. Rejected
// uploads and expired sessions are the other source of dead bytes: their rows are kept
// for the audit trail, while the objects themselves serve no purpose.
//
// The collector is deliberately a separate command rather than a request handler: it
// scans a store, so it is slow, operator initiated and repeatable. Every delete is
// idempotent and a dry-run reports the same plan without touching anything.

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ObjectLister is the optional Storage capability the collector needs to find objects
// no database row refers to. A storage implementation that cannot list still supports
// eager deletion; the collector then reports it as unlistable instead of failing.
type ObjectLister interface {
	// List returns every stored key, relative to the storage root or bucket prefix.
	List(ctx context.Context) ([]string, error)
}

// GarbageCatalog is the read/write port the collector needs.
//
// It is separate from Repository on purpose: the upload path must not depend on a
// cross-site query, and the collector must not widen what a request handler can do.
type GarbageCatalog interface {
	AllAssets(ctx context.Context) ([]Asset, error)
	AllUploads(ctx context.Context) ([]Upload, error)
	MarkUploadExpired(ctx context.Context, uploadID string, at time.Time) error
}

// Cleanup defaults. The retention window is not a security control: a rejected object
// is already unreachable, and the delay only gives an operator time to investigate an
// upload before its bytes are gone. The upload grace covers the window between the last
// successful completion and an operator running the collector.
const (
	DefaultRejectedRetention = 24 * time.Hour
	DefaultUploadGrace       = time.Hour
)

// CollectorConfig configures a Collector.
type CollectorConfig struct {
	Catalog GarbageCatalog
	// Storage is the fallback adapter; Storages optionally override one purpose.
	Storage  Storage
	Storages map[Purpose]Storage

	Now func() time.Time
	// RejectedRetention is how long the bytes of a rejected asset are kept.
	RejectedRetention time.Duration
	// UploadGrace is extra time past an upload session's expiry before its object is
	// treated as abandoned.
	UploadGrace time.Duration
	// AllowUnknownKeys lets the collector delete objects whose key is not shaped like
	// one this service generates. It is off by default: a storage root or bucket that
	// is shared with something else must never turn a cleanup into "delete everything".
	AllowUnknownKeys bool
}

// Collector removes media objects that no asset, open upload or live variant needs.
type Collector struct {
	cfg CollectorConfig
}

// GarbageReport is the outcome of one run. It is JSON friendly so an operator can log
// it, and it is the same plan in dry-run mode with Deleted left at zero.
type GarbageReport struct {
	DryRun         bool `json:"dry_run"`
	Assets         int  `json:"assets"`
	Uploads        int  `json:"uploads"`
	Objects        int  `json:"objects"`
	RejectedAssets int  `json:"rejected_assets"`
	ExpiredUploads int  `json:"expired_uploads"`
	OrphanObjects  int  `json:"orphan_objects"`
	// SkippedUnknown counts objects left alone because their key does not look like a
	// media object. A non-zero value in a dedicated store usually means a stray file.
	SkippedUnknown int      `json:"skipped_unknown"`
	Deleted        int      `json:"deleted"`
	WouldDelete    int      `json:"would_delete"`
	Unlistable     []string `json:"unlistable,omitempty"`
	Errors         []string `json:"errors,omitempty"`
}

// NewCollector validates and defaults a Collector.
func NewCollector(cfg CollectorConfig) (*Collector, error) {
	if cfg.Catalog == nil {
		return nil, errors.New("media: garbage collector needs a catalog")
	}
	if cfg.Storage == nil && len(cfg.Storages) == 0 {
		return nil, errors.New("media: garbage collector needs at least one storage adapter")
	}
	if cfg.Now == nil {
		cfg.Now = func() time.Time { return time.Now().UTC() }
	}
	if cfg.RejectedRetention < 0 {
		return nil, errors.New("media: rejected retention cannot be negative")
	}
	if cfg.RejectedRetention == 0 {
		cfg.RejectedRetention = DefaultRejectedRetention
	}
	if cfg.UploadGrace < 0 {
		return nil, errors.New("media: upload grace cannot be negative")
	}
	if cfg.UploadGrace == 0 {
		cfg.UploadGrace = DefaultUploadGrace
	}
	return &Collector{cfg: cfg}, nil
}

// cleanupPlan groups the work that belongs to one storage adapter. Two purposes may
// share an adapter, and the same object must not be listed twice.
type cleanupPlan struct {
	name    string
	storage Storage
	known   map[string]struct{}
	purge   map[string]struct{}
}

// Run performs one collection pass. dryRun computes the exact same plan but performs no
// delete and no status update.
func (c *Collector) Run(ctx context.Context, dryRun bool) (GarbageReport, error) {
	report := GarbageReport{DryRun: dryRun}
	now := c.cfg.Now()
	cutoff := now.Add(-c.cfg.UploadGrace)

	assets, err := c.cfg.Catalog.AllAssets(ctx)
	if err != nil {
		return report, fmt.Errorf("media gc: list assets: %w", err)
	}
	uploads, err := c.cfg.Catalog.AllUploads(ctx)
	if err != nil {
		return report, fmt.Errorf("media gc: list uploads: %w", err)
	}
	report.Assets = len(assets)
	report.Uploads = len(uploads)

	plans := make([]*cleanupPlan, 0, 4)
	byStorage := make(map[string]*cleanupPlan, 4)
	planFor := func(purpose Purpose) (*cleanupPlan, error) {
		storage := c.storageFor(purpose)
		if storage == nil {
			return nil, fmt.Errorf("media gc: no storage configured for purpose %q", purpose)
		}
		identity := storageIdentity(storage)
		if plan, ok := byStorage[identity]; ok {
			return plan, nil
		}
		name := "global"
		if override, ok := c.cfg.Storages[purpose]; ok && override != nil {
			name = string(purpose)
		}
		plan := &cleanupPlan{
			name:    name,
			storage: storage,
			known:   make(map[string]struct{}),
			purge:   make(map[string]struct{}),
		}
		byStorage[identity] = plan
		plans = append(plans, plan)
		return plan, nil
	}

	liveAssetKeys := make(map[string]struct{}, len(assets))
	for _, asset := range assets {
		plan, planErr := planFor(asset.Purpose)
		if planErr != nil {
			report.Errors = append(report.Errors, planErr.Error())
			continue
		}
		if c.rejectedPurgeable(asset, now) {
			plan.purge[asset.StorageKey] = struct{}{}
			report.RejectedAssets++
			continue
		}
		plan.known[asset.StorageKey] = struct{}{}
		liveAssetKeys[asset.StorageKey] = struct{}{}
	}

	stale := make([]Upload, 0)
	for _, upload := range uploads {
		plan, planErr := planFor(upload.Purpose)
		if planErr != nil {
			report.Errors = append(report.Errors, planErr.Error())
			continue
		}
		if staleUpload(upload, cutoff) {
			stale = append(stale, upload)
			report.ExpiredUploads++
			// A completion that failed after InsertAsset can leave an uploaded row
			// whose object is already an asset. The row is stale, but the bytes now
			// belong to the asset and must not be purged with the session.
			if _, live := liveAssetKeys[upload.StorageKey]; live {
				continue
			}
			plan.purge[upload.StorageKey] = struct{}{}
			continue
		}
		if uploadProtectsObject(upload) {
			plan.known[upload.StorageKey] = struct{}{}
		}
	}

	// Scan every configured adapter even when no row currently points at it. A database
	// whose media rows were all deleted is exactly when leftover objects matter most, so
	// deriving the plan only from live rows would miss the whole point.
	if c.cfg.Storage != nil {
		if _, err := planFor(Purpose("")); err != nil {
			report.Errors = append(report.Errors, err.Error())
		}
	}
	for purpose, storage := range c.cfg.Storages {
		if storage == nil {
			continue
		}
		if _, err := planFor(purpose); err != nil {
			report.Errors = append(report.Errors, err.Error())
		}
	}

	// A deterministic order makes two dry-runs comparable and keeps the report readable.
	sort.SliceStable(plans, func(i, j int) bool { return plans[i].name < plans[j].name })

	for _, plan := range plans {
		// The purge set expands to every derivative of the base key: a rejected image
		// may already have produced variants before the verdict arrived, and a stale
		// upload never produces any, where the deletes are harmless no-ops.
		purged := make(map[string]struct{}, len(plan.purge)*(len(VariantWidths)*3+1))
		for base := range plan.purge {
			purged[base] = struct{}{}
			for _, key := range DerivativeKeys(base) {
				purged[key] = struct{}{}
			}
		}
		for _, key := range sortedKeys(purged) {
			c.deleteObject(ctx, plan.storage, key, dryRun, &report)
		}

		lister, ok := plan.storage.(ObjectLister)
		if !ok {
			report.Unlistable = append(report.Unlistable, plan.name)
			continue
		}
		objects, listErr := lister.List(ctx)
		if listErr != nil {
			report.Errors = append(report.Errors, fmt.Sprintf("list %s: %v", plan.name, listErr))
			continue
		}
		report.Objects += len(objects)

		orphans := make([]string, 0)
		for _, key := range objects {
			if _, ok := purged[key]; ok {
				continue
			}
			if _, ok := plan.known[key]; ok {
				continue
			}
			// A variant is alive as long as its original is.
			if base, isVariant := DerivativeBaseKey(key); isVariant {
				if _, ok := plan.known[base]; ok {
					continue
				}
				if _, ok := purged[base]; ok {
					continue
				}
			}
			if !c.cfg.AllowUnknownKeys && !isMediaObjectKey(key) {
				report.SkippedUnknown++
				continue
			}
			orphans = append(orphans, key)
		}
		sort.Strings(orphans)
		for _, key := range orphans {
			report.OrphanObjects++
			c.deleteObject(ctx, plan.storage, key, dryRun, &report)
		}
	}

	// Marking the session closes the loop: a completed row stops being retried on every
	// run, and the operator can see it in the database. Dry-run leaves it alone.
	if !dryRun {
		for _, upload := range stale {
			if markErr := c.cfg.Catalog.MarkUploadExpired(ctx, upload.ID, now); markErr != nil {
				report.Errors = append(report.Errors,
					fmt.Sprintf("mark upload %s expired: %v", upload.ID, markErr))
			}
		}
	}

	return report, nil
}

// rejectedPurgeable reports whether a rejected asset's bytes may be removed. The row is
// kept: it is the audit record of what was rejected, not the payload.
func (c *Collector) rejectedPurgeable(asset Asset, now time.Time) bool {
	if asset.ScanStatus != ScanRejected {
		return false
	}
	if asset.CreatedAt.IsZero() {
		// Legacy row without an age: leave the object for a human.
		return false
	}
	return !now.Before(asset.CreatedAt.Add(c.cfg.RejectedRetention))
}

// staleUpload reports whether a session was abandoned long enough ago to collect.
func staleUpload(upload Upload, cutoff time.Time) bool {
	switch upload.Status {
	case UploadPending, UploadUploaded:
	default:
		return false
	}
	return !upload.ExpiresAt.After(cutoff)
}

// uploadProtectsObject reports whether an upload row still owns its object.
//
// A completed session does not: its bytes are the asset's responsibility now. If the
// asset row was deleted, the object really is garbage and should be collected.
func uploadProtectsObject(upload Upload) bool {
	return upload.Status == UploadPending || upload.Status == UploadUploaded
}

// isMediaObjectKey reports whether key has the shape NewStorageKey produces: a two
// character shard, then a UUID, then an optional extension or variant suffix.
//
// Orphan collection uses it as a blast radius guard: a bucket or directory shared with
// other data must not lose files merely because they are not in the media table. A
// deployment that really wants unknown keys removed opts in explicitly.
func isMediaObjectKey(key string) bool {
	segments := strings.Split(key, "/")
	if len(segments) != 2 {
		return false
	}
	shard, name := segments[0], segments[1]
	if len(shard) != 2 || len(name) < 36 {
		return false
	}
	if !strings.EqualFold(shard, name[:2]) {
		return false
	}
	if _, err := uuid.Parse(name[:36]); err != nil {
		return false
	}
	rest := name[36:]
	return rest == "" || strings.HasPrefix(rest, ".")
}

// storageFor resolves the adapter for a purpose exactly like Service.storageFor.
func (c *Collector) storageFor(purpose Purpose) Storage {
	if storage, ok := c.cfg.Storages[purpose]; ok && storage != nil {
		return storage
	}
	return c.cfg.Storage
}

// storageIdentity names an adapter by dynamic type and pointer, so two purposes that
// share one adapter share one plan. Non-pointer implementations fall back to the type.
func storageIdentity(storage Storage) string {
	if storage == nil {
		return ""
	}
	value := reflect.ValueOf(storage)
	if value.Kind() == reflect.Ptr {
		return fmt.Sprintf("%T#%x", storage, value.Pointer())
	}
	return fmt.Sprintf("%T", storage)
}

// deleteObject performs or reports one delete.
func (c *Collector) deleteObject(
	ctx context.Context,
	storage Storage,
	key string,
	dryRun bool,
	report *GarbageReport,
) {
	if dryRun {
		report.WouldDelete++
		return
	}
	if err := storage.Delete(ctx, key); err != nil {
		report.Errors = append(report.Errors, fmt.Sprintf("delete %s: %v", key, err))
		return
	}
	report.Deleted++
}

// sortedKeys returns map keys in lexical order.
func sortedKeys(set map[string]struct{}) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// Compile-time proof that both shipped adapters can be listed.
var (
	_ ObjectLister = (*LocalStorage)(nil)
	_ ObjectLister = (*S3Storage)(nil)
)
