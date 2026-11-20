package storageadmin

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"

	"github.com/practacu/practacu-press/internal/media"
)

// routeEntry is one built candidate. The same entry is used for writes (only the
// allocation order) and reads (allocation order plus the fallback list).
type routeEntry struct {
	strategyID string
	target     Target
	store      media.Storage
	quotaBytes int64
}

// routingStorage is the media adapter for one scope (or the global fallback).
// Writes follow the allocation; reads and deletes also try the other built
// strategies so objects written before a quota switch stay reachable.
type routingStorage struct {
	scope    string
	mode     string
	overflow string
	entries  []*routeEntry
	fallback []*routeEntry
	usage    *usageTracker
	log      *slog.Logger
	mu       sync.Mutex
}

func newRoutingStorage(scope string, allocation Allocation, stores map[string]media.Storage, targets map[string]Target, fallback []*routeEntry, usage *usageTracker, logger *slog.Logger) *routingStorage {
	routing := &routingStorage{
		scope:    scope,
		mode:     allocation.Mode,
		overflow: allocation.Overflow,
		usage:    usage,
		log:      logger,
	}
	if routing.mode != ModeQuota {
		routing.mode = ModeSingle
	}
	if routing.overflow != OverflowStop {
		routing.overflow = OverflowSwitch
	}
	for _, entry := range allocation.Entries {
		store, ok := stores[entry.StrategyID]
		if !ok || store == nil {
			continue
		}
		routing.entries = append(routing.entries, &routeEntry{
			strategyID: entry.StrategyID,
			target:     targets[entry.StrategyID],
			store:      store,
			quotaBytes: quotaBytes(entry.QuotaGB),
		})
	}
	routing.fallback = fallback
	return routing
}

func (r *routingStorage) writeCandidates() []*routeEntry {
	if r.mode == ModeSingle && len(r.entries) > 0 {
		return r.entries[:1]
	}
	return r.entries
}

func (r *routingStorage) hasRoom(entry *routeEntry, size int64) bool {
	if entry.quotaBytes <= 0 {
		return true
	}
	used := r.usage.get(entry.strategyID)
	if used >= entry.quotaBytes {
		return false
	}
	return size <= entry.quotaBytes-used
}

// currentEntry is the entry a new write would go to, for status display. Empty
// when every configured entry is full.
func (r *routingStorage) currentEntry() *routeEntry {
	if len(r.entries) == 0 {
		return nil
	}
	if r.mode == ModeSingle {
		return r.entries[0]
	}
	for _, entry := range r.entries {
		if r.hasRoom(entry, 1) || entry.quotaBytes == 0 {
			return entry
		}
	}
	return nil
}

func (r *routingStorage) effectiveEntry() *routeEntry {
	if current := r.currentEntry(); current != nil {
		return current
	}
	if len(r.entries) > 0 {
		return r.entries[0]
	}
	return nil
}

func (r *routingStorage) Put(ctx context.Context, key string, reader io.Reader, size int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	var chosen *routeEntry
	for _, entry := range r.writeCandidates() {
		if r.mode != ModeQuota || r.hasRoom(entry, size) {
			chosen = entry
			break
		}
		if r.overflow == OverflowStop {
			break
		}
	}
	if chosen == nil {
		return media.ErrStorageQuotaExceeded
	}
	if err := chosen.store.Put(ctx, key, reader, size); err != nil {
		return err
	}
	r.usage.add(chosen.strategyID, size)
	return nil
}

// readCandidates returns the allocation entries first, then every other built
// strategy. A key moved out of an allocation therefore stays readable, and a
// removed strategy keeps working until its objects are migrated.
func (r *routingStorage) readCandidates() []*routeEntry {
	out := make([]*routeEntry, 0, len(r.entries)+len(r.fallback))
	seen := make(map[string]struct{}, len(r.entries)+len(r.fallback))
	for _, group := range [][]*routeEntry{r.entries, r.fallback} {
		for _, entry := range group {
			if _, ok := seen[entry.strategyID]; ok {
				continue
			}
			seen[entry.strategyID] = struct{}{}
			out = append(out, entry)
		}
	}
	return out
}

func (r *routingStorage) ReadHead(ctx context.Context, key string, n int) ([]byte, error) {
	for _, entry := range r.readCandidates() {
		head, err := entry.store.ReadHead(ctx, key, n)
		if err == nil {
			return head, nil
		}
		if errors.Is(err, media.ErrStorageObjectMissing) {
			continue
		}
		return nil, err
	}
	return nil, media.ErrStorageObjectMissing
}

func (r *routingStorage) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	for _, entry := range r.readCandidates() {
		reader, err := entry.store.Open(ctx, key)
		if err == nil {
			return reader, nil
		}
		if errors.Is(err, media.ErrStorageObjectMissing) {
			continue
		}
		return nil, err
	}
	return nil, media.ErrStorageObjectMissing
}

func (r *routingStorage) Delete(ctx context.Context, key string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	var firstErr error
	for _, entry := range r.readCandidates() {
		size, sizeErr := storedSize(ctx, entry.store, key)
		if sizeErr != nil && !errors.Is(sizeErr, media.ErrStorageObjectMissing) {
			if firstErr == nil {
				firstErr = sizeErr
			}
			continue
		}
		if err := entry.store.Delete(ctx, key); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if size > 0 {
			r.usage.sub(entry.strategyID, size)
		}
	}
	return firstErr
}

func (r *routingStorage) Size(ctx context.Context, key string) (int64, error) {
	for _, entry := range r.readCandidates() {
		size, err := storedSize(ctx, entry.store, key)
		if err == nil {
			return size, nil
		}
		if errors.Is(err, media.ErrStorageObjectMissing) {
			continue
		}
		return 0, err
	}
	return 0, media.ErrStorageObjectMissing
}

type sizedStorage interface {
	Size(ctx context.Context, key string) (int64, error)
}

func storedSize(ctx context.Context, store media.Storage, key string) (int64, error) {
	sized, ok := store.(sizedStorage)
	if !ok {
		return 0, media.ErrStorageObjectMissing
	}
	return sized.Size(ctx, key)
}
