package storageadmin

import (
	"regexp"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/platform/config"
)

const (
	// SettingsFilename is the runtime storage document under the instance data
	// directory. It contains S3 secrets, so it is written 0600 and never served.
	SettingsFilename = "storage-settings.json"
	// UsageFilename stores the per-strategy byte counters used by capacity switching.
	UsageFilename = "storage-usage.json"

	settingsVersion = 1

	// MaxStrategies mirrors the dashboard limit.
	MaxStrategies = 8
	// MaxAllocationEntries mirrors the dashboard limit.
	MaxAllocationEntries = 8
	// MaxQuotaGB bounds one allocation entry. 1 PB is far beyond any real install
	// and keeps the byte conversion inside int64.
	MaxQuotaGB int64 = 1_000_000

	// ModeSingle uses only the first entry and ignores its quota.
	ModeSingle = "single"
	// ModeQuota writes through the entries in order.
	ModeQuota = "quota"
	// OverflowSwitch moves to the next entry when the current one is full.
	OverflowSwitch = "switch"
	// OverflowStop rejects the write when the first entry is full.
	OverflowStop = "stop"

	// SourceEnv means the running settings were read from .env at boot.
	SourceEnv = "env"
	// SourceSaved means the running settings came from the dashboard document.
	SourceSaved = "saved"
)

var strategyIDPattern = regexp.MustCompile(`^[a-z0-9_-]+$`)

// Target is one storage location.
type Target struct {
	Driver      string `json:"driver"`
	LocalDir    string `json:"local_dir,omitempty"`
	S3Bucket    string `json:"s3_bucket,omitempty"`
	S3Prefix    string `json:"s3_prefix,omitempty"`
	S3Endpoint  string `json:"s3_endpoint,omitempty"`
	S3Region    string `json:"s3_region,omitempty"`
	S3AccessKey string `json:"s3_access_key,omitempty"`
	S3SecretKey string `json:"s3_secret_key,omitempty"`
}

// Strategy is one named storage target.
type Strategy struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Target
}

// AllocationEntry is one entry of a scope's write order.
type AllocationEntry struct {
	StrategyID string `json:"strategy_id"`
	QuotaGB    int64  `json:"quota_gb"`
}

// Allocation describes how one media scope writes.
type Allocation struct {
	Mode     string            `json:"mode"`
	Entries  []AllocationEntry `json:"entries"`
	Overflow string            `json:"overflow"`
}

// Settings is the complete runtime document, including secrets. It is never
// serialized to an API response; Status redacts it first.
type Settings struct {
	Version          int                   `json:"version"`
	UpdatedAt        time.Time             `json:"updated_at"`
	GlobalStrategyID string                `json:"global_strategy_id"`
	Strategies       []Strategy            `json:"strategies"`
	Scopes           map[string]string     `json:"scopes"`
	Allocations      map[string]Allocation `json:"allocations"`
}

// StrategyInput is the dashboard payload for one strategy.
type StrategyInput struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Driver      string `json:"driver"`
	LocalDir    string `json:"local_dir"`
	S3Bucket    string `json:"s3_bucket"`
	S3Prefix    string `json:"s3_prefix"`
	S3Endpoint  string `json:"s3_endpoint"`
	S3Region    string `json:"s3_region"`
	S3AccessKey string `json:"s3_access_key"`
	S3SecretKey string `json:"s3_secret_key"`
}

// AllocationEntryInput is the dashboard payload for one allocation entry.
type AllocationEntryInput struct {
	StrategyID string `json:"strategy_id"`
	QuotaGB    int64  `json:"quota_gb"`
}

// AllocationInput is the dashboard payload for one scope allocation.
type AllocationInput struct {
	Mode     string                 `json:"mode"`
	Entries  []AllocationEntryInput `json:"entries"`
	Overflow string                 `json:"overflow"`
}

// UpdateRequest is the body of PUT /system/storage.
type UpdateRequest struct {
	GlobalStrategyID string                     `json:"global_strategy_id"`
	Strategies       []StrategyInput            `json:"strategies"`
	Scopes           map[string]string          `json:"scopes"`
	Allocations      map[string]AllocationInput `json:"allocations"`
}

// ValidationError names the dashboard field that failed and the rule it broke.
type ValidationError struct {
	Field   string
	Rule    string
	Message string
}

// Error implements error.
func (e *ValidationError) Error() string { return e.Message }

func singleAllocation(strategyID string) Allocation {
	return Allocation{
		Mode:     ModeSingle,
		Entries:  []AllocationEntry{{StrategyID: strategyID, QuotaGB: 0}},
		Overflow: OverflowSwitch,
	}
}

// envSettings maps the deployment's STORAGE_* variables onto the same model the
// dashboard edits. Scoped S3 overrides share the deployment-wide endpoint, region
// and credentials, which is exactly what config.StorageScopeConfig documents.
func envSettings(cfg config.Config) Settings {
	global := Strategy{
		ID:   "env-global",
		Name: "",
		Target: Target{
			Driver:      config.StorageDriverLocal,
			LocalDir:    strings.TrimSpace(cfg.StorageDir),
			S3Bucket:    cfg.S3Bucket,
			S3Prefix:    cfg.S3Prefix,
			S3Endpoint:  cfg.S3Endpoint,
			S3Region:    cfg.S3Region,
			S3AccessKey: cfg.S3AccessKey,
			S3SecretKey: cfg.S3SecretKey,
		},
	}
	if strings.EqualFold(strings.TrimSpace(cfg.StorageDriver), config.StorageDriverS3) {
		global.Driver = config.StorageDriverS3
		global.LocalDir = ""
	}

	settings := Settings{
		Version:          settingsVersion,
		GlobalStrategyID: global.ID,
		Strategies:       []Strategy{global},
		Scopes:           map[string]string{},
		Allocations:      map[string]Allocation{},
	}

	for _, scope := range config.StorageScopeNames() {
		scoped := cfg.StorageScopes[scope]
		switch strings.ToLower(strings.TrimSpace(scoped.Driver)) {
		case config.StorageDriverLocal:
			strategy := Strategy{
				ID:     "env-" + scope,
				Target: Target{Driver: config.StorageDriverLocal, LocalDir: scoped.LocalDir},
			}
			settings.Strategies = append(settings.Strategies, strategy)
			settings.Scopes[scope] = strategy.ID
			settings.Allocations[scope] = singleAllocation(strategy.ID)
		case config.StorageDriverS3:
			strategy := Strategy{
				ID: "env-" + scope,
				Target: Target{
					Driver:      config.StorageDriverS3,
					S3Bucket:    scoped.S3Bucket,
					S3Prefix:    scoped.S3Prefix,
					S3Endpoint:  cfg.S3Endpoint,
					S3Region:    cfg.S3Region,
					S3AccessKey: cfg.S3AccessKey,
					S3SecretKey: cfg.S3SecretKey,
				},
			}
			settings.Strategies = append(settings.Strategies, strategy)
			settings.Scopes[scope] = strategy.ID
			settings.Allocations[scope] = singleAllocation(strategy.ID)
		default:
			settings.Scopes[scope] = global.ID
			settings.Allocations[scope] = singleAllocation(global.ID)
		}
	}
	return settings
}

func quotaBytes(quotaGB int64) int64 {
	if quotaGB <= 0 {
		return 0
	}
	return quotaGB * 1_000_000_000
}

// signature identifies one adapter target. A strategy whose signature did not
// change reuses its adapter and its measured usage across applies.
func (t Target) signature() string {
	return strings.Join([]string{
		t.Driver, t.LocalDir, t.S3Bucket, t.S3Prefix, t.S3Endpoint, t.S3Region,
	}, "\x00")
}
