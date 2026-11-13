// Package extensions is the installation and administration layer above the
// plugin host.
//
// The plugins package owns execution: manifest validation, the WASM sandbox, the
// public boot manifest and the browser asset server. This package owns the
// operator's catalogue: it imports a zip package safely, persists the package
// under the data directory, restores that catalogue on boot and records the
// enable/disable decision that must survive a restart.
//
// One Manager wraps exactly one plugins.Host. The host is already safe for
// concurrent use; the Manager adds a mutex around the filesystem and state file
// so two imports cannot interleave a directory replace and a state write.
package extensions

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/plugins"
)

// Limits of one uploaded extension package.
const (
	// DefaultMaxPackageBytes bounds the zip file itself.
	DefaultMaxPackageBytes int64 = 32 << 20
	// DefaultMaxUnpackedBytes bounds the sum of the unpacked file sizes, which is
	// the bound that stops a small archive from expanding into a disk-filling tree.
	DefaultMaxUnpackedBytes int64 = 64 << 20
	// DefaultMaxFiles bounds the number of regular files in one package.
	DefaultMaxFiles = 200
)

// StateFileName is the sidecar that records the operator's enable/disable choice.
const StateFileName = "state.json"

// StateFileVersion is the only state document version this package understands.
const StateFileVersion = 1

// Sentinel errors. Handlers and callers use errors.Is to map them onto a Problem
// without importing the HTTP layer.
var (
	// ErrInvalidPackage marks a rejected zip: traversal, symlinks, reserved names,
	// a missing root manifest or a manifest that fails validation.
	ErrInvalidPackage = errors.New("extensions: invalid package")
	// ErrPackageTooLarge marks a package that exceeds the upload or unpacked bound.
	ErrPackageTooLarge = errors.New("extensions: package too large")
	// ErrExtensionNotFound marks an id that is neither installed nor on disk.
	ErrExtensionNotFound = errors.New("extensions: extension not found")
)

// Options configures a Manager. Zero values are usable except Host.
type Options struct {
	// Host is the plugin host this manager installs into and reports from. Required.
	Host *plugins.Host
	// DataDir is the data root; packages live in <DataDir>/extensions and the state
	// file is <DataDir>/extensions/state.json. Empty means "./data".
	DataDir string
	// Logger receives scan, import and persistence failures. Nil discards them.
	Logger *slog.Logger
	// MaxPackageBytes overrides DefaultMaxPackageBytes for imports. The HTTP layer
	// still enforces its own documented ceiling.
	MaxPackageBytes int64
	// MaxUnpackedBytes overrides DefaultMaxUnpackedBytes.
	MaxUnpackedBytes int64
	// MaxFiles overrides DefaultMaxFiles.
	MaxFiles int
}

// Extension is the administrator projection of one package. The JSON field names
// are the frozen frontend contract: the extension manager page reads exactly
// these keys.
type Extension struct {
	ID          string             `json:"id"`
	Name        string             `json:"name"`
	Version     string             `json:"version"`
	Description string             `json:"description"`
	Author      string             `json:"author,omitempty"`
	License     string             `json:"license,omitempty"`
	Homepage    string             `json:"homepage,omitempty"`
	State       string             `json:"state"`
	Enabled     bool               `json:"enabled"`
	Runtime     string             `json:"runtime"`
	Permissions []string           `json:"permissions"`
	Frontend    *ExtensionFrontend `json:"frontend"`
	Backend     *ExtensionBackend  `json:"backend"`
	LastError   string             `json:"last_error,omitempty"`
	InstalledAt string             `json:"installed_at,omitempty"`
	EnabledAt   string             `json:"enabled_at,omitempty"`
}

// ExtensionFrontend is the browser half of a package. Entry is the absolute
// /plugins/<id>/<version>/... URL the runtime loads; styles are the bundle-relative
// file names the entry directory serves, matching plugins.PublicPlugin.
type ExtensionFrontend struct {
	Entry  string           `json:"entry"`
	Styles []string         `json:"styles"`
	Slots  []string         `json:"slots"`
	Blocks []ExtensionBlock `json:"blocks"`
}

// ExtensionBlock is one content block type declared by the frontend half.
type ExtensionBlock struct {
	Type string `json:"type"`
	Name string `json:"name,omitempty"`
}

// ExtensionBackend is the server half of a package.
type ExtensionBackend struct {
	Wasm        bool             `json:"wasm"`
	Routes      []ExtensionRoute `json:"routes"`
	Hooks       []string         `json:"hooks"`
	TimeoutMS   int              `json:"timeout_ms"`
	MaxMemoryMB int              `json:"max_memory_mb"`
}

// ExtensionRoute is one HTTP endpoint a backend extension serves.
type ExtensionRoute struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Auth   string `json:"auth"`
}

// stateEntry is one persisted enable/disable decision.
type stateEntry struct {
	Enabled bool `json:"enabled"`
}

// stateDocument is the on-disk form of state.json.
type stateDocument struct {
	Version    int                   `json:"version"`
	Extensions map[string]stateEntry `json:"extensions"`
}

// Manager owns the package directory and the plugin host.
type Manager struct {
	host   *plugins.Host
	root   string
	logger *slog.Logger

	maxPackage  int64
	maxUnpacked int64
	maxFiles    int

	mu        sync.RWMutex
	state     map[string]stateEntry
	manifests map[string]plugins.Manifest
	dirs      map[string]string
}

// NewManager builds a manager, adopts every package already on disk and applies
// the persisted enable/disable decisions. A broken package is logged and skipped:
// one bad directory must not stop the process from booting.
func NewManager(options Options) (*Manager, error) {
	if options.Host == nil {
		return nil, errors.New("extensions: a plugin host is required")
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	dataDir := strings.TrimSpace(options.DataDir)
	if dataDir == "" {
		dataDir = "./data"
	}
	root := filepath.Join(dataDir, "extensions")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("extensions: create package root: %w", err)
	}

	manager := &Manager{
		host:        options.Host,
		root:        root,
		logger:      logger,
		maxPackage:  options.MaxPackageBytes,
		maxUnpacked: options.MaxUnpackedBytes,
		maxFiles:    options.MaxFiles,
		state:       make(map[string]stateEntry),
		manifests:   make(map[string]plugins.Manifest),
		dirs:        make(map[string]string),
	}
	if manager.maxPackage <= 0 {
		manager.maxPackage = DefaultMaxPackageBytes
	}
	if manager.maxUnpacked <= 0 {
		manager.maxUnpacked = DefaultMaxUnpackedBytes
	}
	if manager.maxFiles <= 0 {
		manager.maxFiles = DefaultMaxFiles
	}
	manager.state = manager.readState()
	manager.scan()
	return manager, nil
}

// Host returns the wrapped plugin host, or nil for a zero Manager.
func (m *Manager) Host() *plugins.Host {
	if m == nil {
		return nil
	}
	return m.host
}

// Boot returns the enabled browser bundles. It is the same projection the
// /api/v1/plugins boot manifest serves.
func (m *Manager) Boot() []plugins.PublicPlugin {
	if m == nil || m.host == nil {
		return nil
	}
	return m.host.PublicPlugins()
}

// Close releases the plugin host and every wazero runtime it owns.
func (m *Manager) Close() error {
	if m == nil || m.host == nil {
		return nil
	}
	return m.host.Close()
}

// List merges the live host registry with the package manifests on disk.
//
// A package that is on disk but not loaded (a failed compile, for instance) is
// still reported with state "failed", because hiding it would leave the operator
// with a directory they cannot see or delete.
func (m *Manager) List() ([]Extension, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	statuses := m.host.List()
	out := make([]Extension, 0, len(statuses))
	seen := make(map[string]struct{}, len(statuses))
	for _, status := range statuses {
		out = append(out, m.extensionForStatusLocked(status))
		seen[status.ID] = struct{}{}
	}

	entries, err := os.ReadDir(m.root)
	if err != nil {
		return nil, fmt.Errorf("extensions: read package root: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		dir := filepath.Join(m.root, entry.Name())
		manifest, err := plugins.LoadManifest(dir)
		if err != nil {
			// Boot already logged the details; List keeps the catalogue readable.
			continue
		}
		if _, ok := seen[manifest.ID]; ok {
			continue
		}
		out = append(out, Extension{
			ID:          manifest.ID,
			Name:        manifest.Name,
			Version:     manifest.Version,
			Description: manifest.Description,
			Author:      manifest.Author,
			License:     manifest.License,
			Homepage:    manifest.Homepage,
			State:       string(plugins.StateFailed),
			Runtime:     manifest.Runtime,
			Permissions: plugins.SortedPermissionList(manifest.Permissions),
			LastError:   "the package is present on disk but could not be loaded",
		})
	}
	return out, nil
}

// SetEnabled turns one installed extension on or off and persists the decision.
func (m *Manager) SetEnabled(id string, enabled bool) (Extension, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	status, ok := m.host.Get(id)
	if !ok {
		return Extension{}, fmt.Errorf("%w: %s", ErrExtensionNotFound, id)
	}
	var err error
	if enabled {
		status, err = m.host.Enable(id)
	} else {
		status, err = m.host.Disable(id)
	}
	if err != nil {
		return Extension{}, fmt.Errorf("extensions: %s: %w", id, err)
	}
	m.state[id] = stateEntry{Enabled: enabled}
	m.persistLocked()
	return m.extensionForStatusLocked(status), nil
}

// Remove unloads an extension and deletes its package directory and state entry.
func (m *Manager) Remove(id string) error {
	dir, err := m.extensionDir(id)
	if err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	_, installed := m.host.Get(id)
	if !installed {
		if _, statErr := os.Stat(dir); errors.Is(statErr, os.ErrNotExist) {
			return fmt.Errorf("%w: %s", ErrExtensionNotFound, id)
		}
	}
	if installed {
		if err := m.host.Remove(id); err != nil {
			return fmt.Errorf("extensions: unload %s: %w", id, err)
		}
	}
	if err := os.RemoveAll(dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("extensions: delete package %s: %w", id, err)
	}
	delete(m.state, id)
	delete(m.manifests, id)
	delete(m.dirs, id)
	m.persistLocked()
	return nil
}

// extensionDir validates an id before it becomes a path element. The id arrives
// from a URL path parameter, so this is the one place that keeps a crafted value
// such as ".." from turning Remove into a recursive delete outside the root.
func (m *Manager) extensionDir(id string) (string, error) {
	if id == "" || id == "." || id == ".." ||
		strings.HasPrefix(id, ".") ||
		strings.ContainsAny(id, `/\:`) {
		return "", fmt.Errorf("%w: %q", ErrExtensionNotFound, id)
	}
	dir := filepath.Join(m.root, id)
	relative, err := filepath.Rel(m.root, dir)
	if err != nil || relative != id {
		return "", fmt.Errorf("%w: %q", ErrExtensionNotFound, id)
	}
	return dir, nil
}

// extensionForStatusLocked projects one host status. The manifest comes from the
// in-memory catalogue, falling back to the directory the host installed from.
func (m *Manager) extensionForStatusLocked(status plugins.Status) Extension {
	manifest, ok := m.manifests[status.ID]
	if !ok {
		dir := m.dirs[status.ID]
		if dir == "" {
			dir = filepath.Join(m.root, status.ID)
		}
		loaded, err := plugins.LoadManifest(dir)
		if err != nil {
			m.logger.Warn("read extension manifest failed",
				"extension", status.ID, "error", err)
			return extensionFromStatus(status)
		}
		manifest = loaded
	}
	return extensionFromManifest(manifest, status)
}

// extensionFromManifest builds the frontend DTO for one loaded package.
func extensionFromManifest(manifest plugins.Manifest, status plugins.Status) Extension {
	extension := Extension{
		ID:          manifest.ID,
		Name:        manifest.Name,
		Version:     manifest.Version,
		Description: manifest.Description,
		Author:      manifest.Author,
		License:     manifest.License,
		Homepage:    manifest.Homepage,
		State:       string(status.State),
		Enabled:     status.State == plugins.StateEnabled,
		Runtime:     manifest.Runtime,
		Permissions: plugins.SortedPermissionList(manifest.Permissions),
		LastError:   status.LastError,
		InstalledAt: formatTime(status.Installed),
		EnabledAt:   formatTime(status.EnabledAt),
	}
	if manifest.Frontend != nil {
		frontend := manifest.Frontend
		styles := make([]string, 0, len(frontend.Styles))
		for _, style := range frontend.Styles {
			styles = append(styles, path.Base(style))
		}
		blocks := make([]ExtensionBlock, 0, len(frontend.Blocks))
		for _, block := range frontend.Blocks {
			blocks = append(blocks, ExtensionBlock{Type: block.Type, Name: block.Name})
		}
		extension.Frontend = &ExtensionFrontend{
			// The runtime serves the browser half under the versioned asset URL, the
			// same shape plugins.PublicPlugin announces.
			Entry:  fmt.Sprintf("/plugins/%s/%s/%s", manifest.ID, manifest.Version, path.Base(frontend.Entry)),
			Styles: styles,
			Slots:  append([]string{}, frontend.Slots...),
			Blocks: blocks,
		}
	}
	if manifest.Backend != nil {
		backend := manifest.Backend
		routes := make([]ExtensionRoute, 0, len(backend.Routes))
		for _, route := range backend.Routes {
			routes = append(routes, ExtensionRoute{
				Method: route.Method,
				Path:   route.Path,
				Auth:   routeAuth(route),
			})
		}
		timeout := backend.TimeoutMS
		if timeout <= 0 {
			timeout = int(plugins.DefaultTimeout / time.Millisecond)
		}
		memory := backend.MaxMemoryMB
		if memory <= 0 {
			memory = plugins.DefaultMaxMemoryMB
		}
		extension.Backend = &ExtensionBackend{
			Wasm:        true,
			Routes:      routes,
			Hooks:       append([]string{}, backend.Hooks...),
			TimeoutMS:   timeout,
			MaxMemoryMB: memory,
		}
	}
	return extension
}

// extensionFromStatus is the degraded projection used when the manifest cannot be
// read back; the host status alone still tells the operator what is running.
func extensionFromStatus(status plugins.Status) Extension {
	return Extension{
		ID:          status.ID,
		Name:        status.Name,
		Version:     status.Version,
		State:       string(status.State),
		Enabled:     status.State == plugins.StateEnabled,
		Runtime:     status.Runtime,
		Permissions: append([]string{}, status.Permissions...),
		LastError:   status.LastError,
		InstalledAt: formatTime(status.Installed),
		EnabledAt:   formatTime(status.EnabledAt),
	}
}

func routeAuth(route plugins.Route) string {
	if route.Auth == "" {
		return "public"
	}
	return route.Auth
}

// formatTime renders an optional timestamp; the zero value is omitted.
func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

// readState loads the persisted decisions. A missing, unreadable or malformed
// file is logged and treated as "no decisions yet": boot must not be blocked by
// a sidecar an operator can delete.
func (m *Manager) readState() map[string]stateEntry {
	state := make(map[string]stateEntry)
	raw, err := os.ReadFile(filepath.Join(m.root, StateFileName))
	if errors.Is(err, os.ErrNotExist) {
		return state
	}
	if err != nil {
		m.logger.Warn("read extension state failed", "error", err)
		return state
	}
	var document stateDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		m.logger.Warn("extension state is not valid JSON", "error", err)
		return state
	}
	if document.Version != StateFileVersion {
		m.logger.Warn("unexpected extension state version",
			"version", document.Version, "expected", StateFileVersion)
		return state
	}
	for id, entry := range document.Extensions {
		state[id] = entry
	}
	return state
}

// persistLocked writes state.json through a temporary file so a crash cannot leave
// a half written document behind. Callers hold m.mu.
func (m *Manager) persistLocked() {
	document := stateDocument{Version: StateFileVersion, Extensions: m.state}
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		m.logger.Error("encode extension state failed", "error", err)
		return
	}
	raw = append(raw, '\n')
	temp, err := os.CreateTemp(m.root, ".state-*.json")
	if err != nil {
		m.logger.Error("create extension state temp file failed", "error", err)
		return
	}
	name := temp.Name()
	if _, err := temp.Write(raw); err != nil {
		_ = temp.Close()
		_ = os.Remove(name)
		m.logger.Error("write extension state failed", "error", err)
		return
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(name)
		m.logger.Error("close extension state temp file failed", "error", err)
		return
	}
	if err := os.Rename(name, filepath.Join(m.root, StateFileName)); err != nil {
		_ = os.Remove(name)
		m.logger.Error("replace extension state failed", "error", err)
	}
}

// scan adopts the packages already on disk and applies the persisted decisions.
func (m *Manager) scan() {
	entries, err := os.ReadDir(m.root)
	if err != nil {
		m.logger.Error("scan extension packages failed", "error", err)
		return
	}
	known := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		dir := filepath.Join(m.root, entry.Name())
		manifest, err := plugins.LoadManifest(dir)
		if err != nil {
			m.logger.Warn("skipping invalid extension package",
				"package", entry.Name(), "error", err)
			continue
		}
		if _, err := m.host.Install(dir); err != nil {
			m.logger.Warn("installing extension package failed",
				"extension", manifest.ID, "package", entry.Name(), "error", err)
			continue
		}
		// A package without a persisted decision starts enabled: the operator put it
		// on disk on purpose, and the host never runs it until Enable is called.
		enabled := true
		if decision, ok := m.state[manifest.ID]; ok {
			enabled = decision.Enabled
		}
		if enabled {
			if _, err := m.host.Enable(manifest.ID); err != nil {
				m.logger.Warn("enabling extension failed", "extension", manifest.ID, "error", err)
			}
		} else if _, err := m.host.Disable(manifest.ID); err != nil {
			m.logger.Warn("disabling extension failed", "extension", manifest.ID, "error", err)
		}
		m.state[manifest.ID] = stateEntry{Enabled: enabled}
		m.manifests[manifest.ID] = manifest
		m.dirs[manifest.ID] = dir
		known[manifest.ID] = struct{}{}
	}
	// A deleted package must not keep a decision around forever.
	for id := range m.state {
		if _, ok := known[id]; !ok {
			delete(m.state, id)
		}
	}
	m.persistLocked()
}
