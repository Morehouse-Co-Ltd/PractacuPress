package storageadmin

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/practacu/practacu-press/internal/platform/config"
)

func readSettingsFile(path string) (Settings, bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Settings{}, false, nil
		}
		return Settings{}, false, err
	}
	var settings Settings
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&settings); err != nil {
		return Settings{}, false, fmt.Errorf("decode %s: %w", path, err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return Settings{}, false, fmt.Errorf("decode %s: %w", path, err)
	}
	if _, exists := fields["max_content_chars"]; !exists {
		settings.MaxContentChars = config.DefaultMaxContentSourceChars
	}
	if err := validateSettings(settings); err != nil {
		return Settings{}, false, fmt.Errorf("validate %s: %w", path, err)
	}
	return settings, true, nil
}

func writeSettingsFile(path string, settings Settings) error {
	payload, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(payload, '\n'))
}

func writeFileAtomic(path string, payload []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer func() {
		_ = os.Remove(tempName)
	}()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}

// usageFile is the persisted per-strategy byte counter.
type usageFile struct {
	Version int              `json:"version"`
	Usage   map[string]int64 `json:"usage"`
}

// usageTracker owns the quota counters. Keys are strategy ids, not scopes: a
// strategy reused by two scopes has one physical target, so one counter keeps the
// two views consistent and makes restarts cheap.
type usageTracker struct {
	mu    sync.Mutex
	path  string
	usage map[string]int64
	log   *slog.Logger
}

func newUsageTracker(path string, logger *slog.Logger) *usageTracker {
	return &usageTracker{path: path, usage: map[string]int64{}, log: logger}
}

func (u *usageTracker) load() error {
	raw, err := os.ReadFile(u.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var document usageFile
	if err := json.Unmarshal(raw, &document); err != nil {
		return err
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	for key, value := range document.Usage {
		if value > 0 {
			u.usage[key] = value
		}
	}
	return nil
}

func (u *usageTracker) snapshot() map[string]int64 {
	u.mu.Lock()
	defer u.mu.Unlock()
	out := make(map[string]int64, len(u.usage))
	for key, value := range u.usage {
		out[key] = value
	}
	return out
}

func (u *usageTracker) get(strategyID string) int64 {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.usage[strategyID]
}

func (u *usageTracker) add(strategyID string, delta int64) {
	if delta <= 0 {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.usage[strategyID] += delta
	u.persistLocked()
}

func (u *usageTracker) sub(strategyID string, delta int64) {
	if delta <= 0 {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	next := u.usage[strategyID] - delta
	if next < 0 {
		next = 0
	}
	u.usage[strategyID] = next
	u.persistLocked()
}

// replace installs the counters computed for a new configuration.
func (u *usageTracker) replace(next map[string]int64) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.usage = make(map[string]int64, len(next))
	for key, value := range next {
		if value > 0 {
			u.usage[key] = value
		}
	}
	u.persistLocked()
}

func (u *usageTracker) persistLocked() {
	if u.path == "" {
		return
	}
	payload, err := json.MarshalIndent(usageFile{Version: settingsVersion, Usage: u.usage}, "", "  ")
	if err != nil {
		if u.log != nil {
			u.log.Warn("persist storage usage", "error", err)
		}
		return
	}
	if err := writeFileAtomic(u.path, append(payload, '\n')); err != nil && u.log != nil {
		u.log.Warn("persist storage usage", "error", err)
	}
}
