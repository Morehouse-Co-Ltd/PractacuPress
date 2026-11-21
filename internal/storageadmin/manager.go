package storageadmin

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/practacu/practacu-press/internal/media"
	"github.com/practacu/practacu-press/internal/platform/config"
)

// AdapterBuilder constructs one media adapter. Tests replace it with a fake.
type AdapterBuilder func(ctx context.Context, target Target) (media.Storage, error)

// BuildError wraps a target that could not be opened (bad bucket, unreachable
// endpoint, unusable directory). The handler reports it as a configuration error,
// not as an internal crash.
type BuildError struct {
	StrategyID string
	Err        error
}

// Error implements error.
func (e *BuildError) Error() string {
	return fmt.Sprintf("build storage strategy %q: %v", e.StrategyID, e.Err)
}

// Unwrap supports errors.Is/As.
func (e *BuildError) Unwrap() error { return e.Err }

// UsageMeasure returns the bytes already stored by an adapter. Tests replace it.
type UsageMeasure func(ctx context.Context, store media.Storage) (int64, error)

// Config assembles a Manager.
type Config struct {
	Env     config.Config
	DataDir string
	Logger  *slog.Logger
	Now     func() time.Time
	Build   AdapterBuilder
	Measure UsageMeasure
}

// Manager owns the active storage strategies and swaps them atomically. All
// request paths read through StorageFor; the dashboard writes through Apply.
type Manager struct {
	env     config.Config
	dataDir string
	logger  *slog.Logger
	now     func() time.Time
	build   AdapterBuilder
	measure UsageMeasure

	applyMu sync.Mutex

	mu         sync.RWMutex
	settings   Settings
	source     string
	global     *routingStorage
	scopes     map[media.Purpose]*routingStorage
	stores     map[string]media.Storage
	signatures map[string]string

	usage *usageTracker
}

type builtState struct {
	global     *routingStorage
	scopes     map[media.Purpose]*routingStorage
	stores     map[string]media.Storage
	signatures map[string]string
	usage      map[string]int64
}

// NewManager loads the persisted document (or converts .env), builds every used
// adapter and measures existing usage. A malformed document or a target that
// cannot be reached fails startup, matching the old env-driven behaviour: serving
// with a different bucket than the operator configured would be worse.
func NewManager(cfg Config) (*Manager, error) {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	build := cfg.Build
	if build == nil {
		build = defaultBuild
	}
	dataDir := strings.TrimSpace(cfg.DataDir)
	if dataDir == "" {
		dataDir = strings.TrimSpace(filepath.Dir(strings.TrimSpace(cfg.Env.StorageDir)))
	}
	if dataDir == "." {
		dataDir = ""
	}

	manager := &Manager{
		env:        cfg.Env,
		dataDir:    dataDir,
		logger:     logger,
		now:        now,
		build:      build,
		measure:    cfg.Measure,
		stores:     map[string]media.Storage{},
		signatures: map[string]string{},
	}

	usagePath := ""
	if dataDir != "" {
		usagePath = filepath.Join(dataDir, UsageFilename)
	}
	manager.usage = newUsageTracker(usagePath, logger)
	if err := manager.usage.load(); err != nil {
		logger.Warn("read storage usage counters", "error", err, "path", usagePath)
	}

	settings := envSettings(cfg.Env)
	source := SourceEnv
	if dataDir != "" {
		saved, ok, err := readSettingsFile(filepath.Join(dataDir, SettingsFilename))
		if err != nil {
			return nil, err
		}
		if ok {
			settings = saved
			source = SourceSaved
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	state, err := manager.buildState(ctx, settings, nil, nil)
	if err != nil {
		return nil, err
	}

	manager.settings = settings
	manager.source = source
	manager.global = state.global
	manager.scopes = state.scopes
	manager.stores = state.stores
	manager.signatures = state.signatures
	manager.usage.replace(state.usage)
	return manager, nil
}

func defaultBuild(ctx context.Context, target Target) (media.Storage, error) {
	switch target.Driver {
	case config.StorageDriverLocal:
		return media.NewLocalStorage(target.LocalDir)
	case config.StorageDriverS3:
		return media.NewS3Storage(ctx, media.S3Config{
			Bucket:    target.S3Bucket,
			Region:    target.S3Region,
			Endpoint:  target.S3Endpoint,
			AccessKey: target.S3AccessKey,
			SecretKey: target.S3SecretKey,
			Prefix:    target.S3Prefix,
		})
	default:
		return nil, fmt.Errorf("unsupported storage driver %q", target.Driver)
	}
}

func (m *Manager) buildState(
	ctx context.Context,
	settings Settings,
	previousStores map[string]media.Storage,
	previousSignatures map[string]string,
) (*builtState, error) {
	byID := make(map[string]Strategy, len(settings.Strategies))
	for _, strategy := range settings.Strategies {
		byID[strategy.ID] = strategy
	}
	used := usedStrategyIDs(settings)

	stores := make(map[string]media.Storage, len(used))
	signatures := make(map[string]string, len(used))
	usage := make(map[string]int64, len(used))
	for _, id := range used {
		strategy, ok := byID[id]
		if !ok {
			return nil, fmt.Errorf("storage strategy %q is referenced but missing", id)
		}
		signature := strategy.Target.signature()
		if store := previousStores[id]; store != nil && previousSignatures[id] == signature {
			stores[id] = store
			signatures[id] = signature
			usage[id] = m.usage.get(id)
			continue
		}

		store, err := m.build(ctx, strategy.Target)
		if err != nil {
			return nil, &BuildError{StrategyID: id, Err: err}
		}
		stores[id] = store
		signatures[id] = signature

		measured, measureErr := m.measureStore(ctx, store)
		if measureErr != nil {
			// Measurement is accounting, not connectivity: the adapter was built, so
			// keep serving and fall back to the last persisted counter. A stale counter
			// can only switch earlier, never overwrite data.
			m.logger.Warn("measure storage usage", "strategy", id, "error", measureErr)
			measured = m.usage.get(id)
		}
		usage[id] = measured
		m.logger.Info("media storage ready", "strategy", id, "driver", strategy.Driver,
			"bucket", strategy.S3Bucket, "dir", strategy.LocalDir)
	}

	targets := make(map[string]Target, len(byID))
	for id, strategy := range byID {
		targets[id] = strategy.Target
	}

	fallback := make([]*routeEntry, 0, len(used))
	for _, id := range used {
		fallback = append(fallback, &routeEntry{
			strategyID: id,
			target:     byID[id].Target,
			store:      stores[id],
		})
	}

	global := newRoutingStorage("global", singleAllocation(settings.GlobalStrategyID), stores, targets, fallback, m.usage, m.logger)
	scopes := make(map[media.Purpose]*routingStorage, len(config.StorageScopeNames()))
	for _, scope := range config.StorageScopeNames() {
		allocation := settings.Allocations[scope]
		if len(allocation.Entries) == 0 {
			allocation = singleAllocation(settings.GlobalStrategyID)
		}
		scopes[media.Purpose(scope)] = newRoutingStorage(scope, allocation, stores, targets, fallback, m.usage, m.logger)
	}

	return &builtState{
		global:     global,
		scopes:     scopes,
		stores:     stores,
		signatures: signatures,
		usage:      usage,
	}, nil
}

func (m *Manager) measureStore(ctx context.Context, store media.Storage) (int64, error) {
	if m.measure != nil {
		return m.measure(ctx, store)
	}
	measurable, ok := store.(interface {
		Usage(ctx context.Context) (int64, error)
	})
	if !ok {
		return 0, nil
	}
	return measurable.Usage(ctx)
}

// Apply validates the dashboard document, builds every new target, persists the
// document and only then swaps the live routing. A failure at any step leaves the
// previous adapters serving traffic.
func (m *Manager) Apply(ctx context.Context, in UpdateRequest) (Status, error) {
	m.applyMu.Lock()
	defer m.applyMu.Unlock()

	m.mu.RLock()
	previous := m.settings
	previousStores := m.stores
	previousSignatures := m.signatures
	m.mu.RUnlock()

	next, err := normalizeRequest(in, previous, m.now())
	if err != nil {
		return Status{}, err
	}

	applyCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	state, err := m.buildState(applyCtx, next, previousStores, previousSignatures)
	if err != nil {
		return Status{}, err
	}

	if m.dataDir != "" {
		if err := writeSettingsFile(filepath.Join(m.dataDir, SettingsFilename), next); err != nil {
			return Status{}, fmt.Errorf("persist storage settings: %w", err)
		}
	}
	m.usage.replace(state.usage)

	m.mu.Lock()
	m.settings = next
	m.source = SourceSaved
	m.global = state.global
	m.scopes = state.scopes
	m.stores = state.stores
	m.signatures = state.signatures
	m.mu.Unlock()

	return m.Status(), nil
}

// StorageFor resolves the adapter for one media purpose. It is the only entry
// point the media service uses, so a swap is visible on the next call.
func (m *Manager) StorageFor(purpose media.Purpose) media.Storage {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if routing := m.scopes[purpose]; routing != nil {
		return routing
	}
	if m.global != nil {
		return m.global
	}
	return nil
}

// Status returns the redacted runtime view served by GET /system/storage.
func (m *Manager) Status() Status {
	m.mu.RLock()
	settings := m.settings
	source := m.source
	global := m.global
	scopes := m.scopes
	m.mu.RUnlock()

	status := Status{
		Live:             true,
		Source:           source,
		MaxContentChars:  settings.MaxContentChars,
		GlobalStrategyID: settings.GlobalStrategyID,
		Strategies:       make([]StrategyStatus, 0, len(settings.Strategies)),
		Scopes:           make(map[string]string, len(settings.Scopes)),
		Allocations:      make(map[string]AllocationStatus, len(settings.Allocations)),
		Effective:        make([]EffectiveStorage, 0, 1+len(config.StorageScopeNames())),
	}
	if !settings.UpdatedAt.IsZero() {
		updated := settings.UpdatedAt
		status.UpdatedAt = &updated
	}

	for _, strategy := range settings.Strategies {
		status.Strategies = append(status.Strategies, StrategyStatus{
			ID:           strategy.ID,
			Name:         strategy.Name,
			Driver:       strategy.Driver,
			LocalDir:     strategy.LocalDir,
			S3Bucket:     strategy.S3Bucket,
			S3Prefix:     strategy.S3Prefix,
			S3Endpoint:   strategy.S3Endpoint,
			S3Region:     strategy.S3Region,
			HasAccessKey: strategy.S3AccessKey != "",
			HasSecret:    strategy.S3SecretKey != "",
		})
	}

	for _, scope := range config.StorageScopeNames() {
		allocation := settings.Allocations[scope]
		status.Scopes[scope] = settings.Scopes[scope]
		status.Allocations[scope] = m.allocationStatus(allocation, scopes[media.Purpose(scope)])
	}

	status.Effective = append(status.Effective, effectiveRow("global", global))
	for _, scope := range config.StorageScopeNames() {
		status.Effective = append(status.Effective, effectiveRow(scope, scopes[media.Purpose(scope)]))
	}
	return status
}

// MaxContentChars returns the current content body ceiling. It changes with the
// storage settings document and is read by content validation on each write.
func (m *Manager) MaxContentChars() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.settings.MaxContentChars >= 1 && m.settings.MaxContentChars <= config.DefaultMaxContentSourceChars {
		return m.settings.MaxContentChars
	}
	return config.DefaultMaxContentSourceChars
}

func (m *Manager) allocationStatus(allocation Allocation, routing *routingStorage) AllocationStatus {
	currentID := ""
	if routing != nil {
		if entry := routing.currentEntry(); entry != nil {
			currentID = entry.strategyID
		}
	}
	entries := make([]AllocationEntryStatus, 0, len(allocation.Entries))
	for _, entry := range allocation.Entries {
		entries = append(entries, AllocationEntryStatus{
			StrategyID: entry.StrategyID,
			QuotaGB:    entry.QuotaGB,
			UsedBytes:  m.usage.get(entry.StrategyID),
			Current:    entry.StrategyID == currentID,
		})
	}
	return AllocationStatus{Mode: allocation.Mode, Entries: entries, Overflow: allocation.Overflow}
}

func effectiveRow(scope string, routing *routingStorage) EffectiveStorage {
	row := EffectiveStorage{Scope: scope, Driver: config.StorageDriverLocal}
	if routing == nil {
		return row
	}
	entry := routing.effectiveEntry()
	if entry == nil {
		return row
	}
	row.Driver = entry.target.Driver
	row.LocalDir = entry.target.LocalDir
	row.S3Bucket = entry.target.S3Bucket
	row.S3Region = entry.target.S3Region
	row.S3Prefix = entry.target.S3Prefix
	return row
}

// MediaRoots describes every target a backup package must walk. Entries that are
// not currently being written are included: their objects still exist.
func (m *Manager) MediaRoots() []MediaRoot {
	m.mu.RLock()
	global := m.global
	scopes := m.scopes
	m.mu.RUnlock()

	groups := make([]struct {
		scope   string
		routing *routingStorage
	}, 0, 1+len(config.StorageScopeNames()))
	groups = append(groups, struct {
		scope   string
		routing *routingStorage
	}{"global", global})
	for _, scope := range config.StorageScopeNames() {
		groups = append(groups, struct {
			scope   string
			routing *routingStorage
		}{scope, scopes[media.Purpose(scope)]})
	}

	roots := make([]MediaRoot, 0, 1+len(config.StorageScopeNames())*2)
	seen := make(map[string]struct{})
	for _, group := range groups {
		if group.routing == nil {
			continue
		}
		for index, entry := range group.routing.entries {
			key := entry.target.Driver + "\x00" + entry.target.LocalDir + "\x00" + entry.target.S3Bucket + "\x00" + entry.target.S3Prefix
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			alias := group.scope
			if index > 0 {
				alias = fmt.Sprintf("%s-%d", group.scope, index+1)
			}
			roots = append(roots, MediaRoot{Alias: alias, Driver: entry.target.Driver, Dir: entry.target.LocalDir})
		}
	}
	return roots
}

// usedStrategyIDs keeps settings order so the fallback list is deterministic.
func usedStrategyIDs(settings Settings) []string {
	referenced := map[string]struct{}{settings.GlobalStrategyID: {}}
	for _, scope := range config.StorageScopeNames() {
		for _, entry := range settings.Allocations[scope].Entries {
			referenced[entry.StrategyID] = struct{}{}
		}
	}
	out := make([]string, 0, len(referenced))
	for _, strategy := range settings.Strategies {
		if _, ok := referenced[strategy.ID]; ok {
			out = append(out, strategy.ID)
		}
	}
	return out
}
