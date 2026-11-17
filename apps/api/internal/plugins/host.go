package plugins

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// Host defaults. They are deliberately small: a plugin hook is a request-path
// operation, not a batch job.
const (
	DefaultTimeout      = 500 * time.Millisecond
	DefaultMaxMemoryMB  = 128
	MaxRequestBodyBytes = 1 << 20
	MaxResponseBody     = 4 << 20
	MaxHookHTMLBytes    = 8 << 20
	MaxStderrBytes      = 4 << 10
)

// State is the lifecycle state of one installed plugin.
type State string

const (
	// StateInstalled means the package is valid but not running.
	StateInstalled State = "installed"
	// StateEnabled means the plugin may receive hooks and requests.
	StateEnabled State = "enabled"
	// StateDisabled means the operator turned it off. It stays installed.
	StateDisabled State = "disabled"
	// StateFailed means activation failed. The error is retained for diagnostics.
	StateFailed State = "failed"
)

// Options configures a Host. Zero values are usable.
type Options struct {
	// HostVersion is the running Practacu Press version, checked against
	// engines.pp. Empty means "skip the check" (tests, tooling).
	HostVersion string
	// ContractVersion is the OpenAPI contract version, checked against
	// engines.contract.
	ContractVersion string
	// Logger receives lifecycle and plugin failures. Nil discards them.
	Logger *slog.Logger
	// DefaultTimeout overrides DefaultTimeout for plugins that do not set one.
	DefaultTimeout time.Duration
}

// Plugin is one installed package. Fields other than the manifest are owned by
// the host; callers receive copies.
type Plugin struct {
	Manifest  Manifest
	Dir       string
	State     State
	LastError string
	EnabledAt time.Time
	Installed time.Time

	// ManifestHash is the SHA-256 of the manifest recorded at install time and
	// re-checked at enable time. Integrity is the resulting trust state. They are
	// copies, not a live view: List and Get report what the last verify saw, and
	// install/enable are the points that refresh them.
	ManifestHash string
	Integrity    IntegrityState
	VerifiedAt   time.Time

	// Each plugin owns its own wazero runtime. That costs a little memory but
	// buys three things the global runtime cannot: a per-plugin memory limit, a
	// timeout that can terminate one plugin without touching the others, and a
	// close/unload path that is a real boundary rather than a flag.
	runtime  wazero.Runtime
	compiled wazero.CompiledModule
	wasm     []byte
	memoryMB int
}

// PublicPlugin is the browser boot record of an enabled plugin. It contains no
// server paths and no secrets.
type PublicPlugin struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	Version      string      `json:"version"`
	Description  string      `json:"description,omitempty"`
	Entry        string      `json:"entry"`
	Styles       []string    `json:"styles,omitempty"`
	Slots        []string    `json:"slots,omitempty"`
	Blocks       []BlockSpec `json:"blocks,omitempty"`
	Permissions  []string    `json:"permissions,omitempty"`
	Integrity    string      `json:"integrity,omitempty"`
	Settings     bool        `json:"settings,omitempty"`
	ManifestHash string      `json:"manifest_hash,omitempty"`
}

// Status is the administrator projection of a plugin.
type Status struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Version     string    `json:"version"`
	State       State     `json:"state"`
	Runtime     string    `json:"runtime"`
	Permissions []string  `json:"permissions"`
	LastError   string    `json:"last_error,omitempty"`
	Installed   time.Time `json:"installed_at,omitempty"`
	EnabledAt   time.Time `json:"enabled_at,omitempty"`
	// ManifestHash is the digest of the manifest as installed (Beta 1.2).
	ManifestHash string `json:"manifest_hash,omitempty"`
	// Integrity is verified, unsigned or mismatch (Beta 1.2).
	Integrity IntegrityState `json:"integrity,omitempty"`
	// VerifiedAt is when the digest was recorded, zero for unsigned packages.
	VerifiedAt time.Time `json:"verified_at,omitempty"`
}

// RequestInfo is what the HTTP layer knows about a plugin request. The router
// fills it into the request context so this package stays free of gin.
type RequestInfo struct {
	SiteID        string
	UserID        string
	Role          string
	Authenticated bool
}

type requestInfoKey struct{}

// WithRequestInfo attaches the resolved site and principal to a request.
func WithRequestInfo(ctx context.Context, info RequestInfo) context.Context {
	return context.WithValue(ctx, requestInfoKey{}, info)
}

// RequestInfoFrom returns the request information, or the zero value.
func RequestInfoFrom(ctx context.Context) RequestInfo {
	info, _ := ctx.Value(requestInfoKey{}).(RequestInfo)
	return info
}

// HookPayload is the content passed to a content hook. The fields are a stable
// ABI: adding one is compatible, renaming one is not.
type HookPayload struct {
	HTML      string         `json:"html,omitempty"`
	SiteID    string         `json:"site_id"`
	ContentID string         `json:"content_id,omitempty"`
	Kind      string         `json:"kind,omitempty"`
	Locale    string         `json:"locale,omitempty"`
	ActorRole string         `json:"actor_role,omitempty"`
	Extra     map[string]any `json:"extra,omitempty"`
}

// HookResult is one plugin's answer to a hook.
type HookResult struct {
	PluginID string
	HTML     string
	Error    error
}

// Host owns the plugin registry, the WASM runtime and the contract cache.
//
// A Host is safe for concurrent use. Enable/Disable/Install take the write
// lock; requests and hooks read a snapshot of the enabled set.
type Host struct {
	options Options
	logger  *slog.Logger

	mu       sync.RWMutex
	plugins  map[string]*Plugin
	order    []string
	dirty    bool
	contract []byte
	closed   bool

	moduleSeq atomic.Uint64
}

// New creates a host. The caller must Close it.
func New(options Options) (*Host, error) {
	logger := options.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if options.DefaultTimeout <= 0 {
		options.DefaultTimeout = DefaultTimeout
	}
	return &Host{
		options: options,
		logger:  logger,
		plugins: make(map[string]*Plugin),
		order:   make([]string, 0, 8),
		dirty:   true,
	}, nil
}

// newPluginRuntime creates an isolated runtime for one plugin. WASI is
// instantiated per runtime so a plugin can only reach the standard streams the
// host hands it for one invocation.
func newPluginRuntime(memoryMB int) (wazero.Runtime, error) {
	if memoryMB <= 0 {
		memoryMB = DefaultMaxMemoryMB
	}
	config := wazero.NewRuntimeConfig().
		WithMemoryLimitPages(uint32(memoryMB) * 1024 * 1024 / 65536).
		WithCloseOnContextDone(true)
	runtime := wazero.NewRuntimeWithConfig(context.Background(), config)
	if _, err := wasi_snapshot_preview1.Instantiate(context.Background(), runtime); err != nil {
		_ = runtime.Close(context.Background())
		return nil, fmt.Errorf("plugins: initialize wasi: %w", err)
	}
	return runtime, nil
}

// Close releases every plugin runtime and compiled module.
func (h *Host) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	h.closed = true
	for _, plugin := range h.plugins {
		if plugin.runtime != nil {
			_ = plugin.runtime.Close(context.Background())
			plugin.runtime = nil
		}
		plugin.compiled = nil
	}
	h.plugins = make(map[string]*Plugin)
	h.order = nil
	return nil
}

// Install validates a plugin directory, compiles its backend and registers it
// in the installed (not running) state.
func (h *Host) Install(dir string) (Status, error) {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return Status{}, fmt.Errorf("plugins: resolve directory: %w", err)
	}
	manifest, err := LoadManifest(absolute)
	if err != nil {
		return Status{}, err
	}
	// Record the digest of the manifest this compile was based on. A package with
	// no sidecar is unsigned rather than rejected: existing installations predate
	// integrity tracking, and refusing them would make the feature a breaking
	// upgrade. Enable re-checks the digest and refuses a mismatch.
	verification, err := VerifyManifest(absolute)
	if err != nil {
		return Status{}, fmt.Errorf("plugins: verify manifest of %s: %w", manifest.ID, err)
	}
	if h.options.HostVersion != "" && !Satisfies(h.options.HostVersion, manifest.Engines.PP) {
		return Status{}, fmt.Errorf("%w: plugin %s requires host %s, running %s",
			ErrInvalidManifest, manifest.ID, manifest.Engines.PP, h.options.HostVersion)
	}
	if h.options.ContractVersion != "" && manifest.Engines.Contract != "" &&
		!Satisfies(h.options.ContractVersion, manifest.Engines.Contract) {
		return Status{}, fmt.Errorf("%w: plugin %s requires contract %s, running %s",
			ErrInvalidManifest, manifest.ID, manifest.Engines.Contract, h.options.ContractVersion)
	}

	// Cheap duplicate check before compiling a multi-megabyte module. The final
	// check under the write lock still handles the race.
	h.mu.RLock()
	_, duplicate := h.plugins[manifest.ID]
	h.mu.RUnlock()
	if duplicate {
		return Status{}, fmt.Errorf("plugins: %s is already installed", manifest.ID)
	}

	var runtime wazero.Runtime
	var compiled wazero.CompiledModule
	var wasmBytes []byte
	memoryMB := 0
	if manifest.Backend != nil {
		binary, readErr := os.ReadFile(filepath.Join(absolute, filepath.FromSlash(manifest.Backend.Entry)))
		if readErr != nil {
			return Status{}, fmt.Errorf("plugins: read backend: %w", readErr)
		}
		wasmBytes = binary
		memoryMB = manifest.Backend.MaxMemoryMB
		runtime, err = newPluginRuntime(memoryMB)
		if err != nil {
			return Status{}, err
		}
		compiled, err = runtime.CompileModule(context.Background(), binary)
		if err != nil {
			_ = runtime.Close(context.Background())
			return Status{}, fmt.Errorf("plugins: compile %s: %w", manifest.ID, err)
		}
	}

	now := time.Now().UTC()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		if runtime != nil {
			_ = runtime.Close(context.Background())
		}
		return Status{}, errors.New("plugins: host is closed")
	}
	if _, exists := h.plugins[manifest.ID]; exists {
		if runtime != nil {
			_ = runtime.Close(context.Background())
		}
		return Status{}, fmt.Errorf("plugins: %s is already installed", manifest.ID)
	}
	plugin := &Plugin{
		Manifest:     manifest,
		Dir:          absolute,
		State:        StateInstalled,
		Installed:    now,
		ManifestHash: reportedManifestHash(verification),
		Integrity:    verification.Integrity,
		VerifiedAt:   verification.VerifiedAt,
		runtime:      runtime,
		compiled:     compiled,
		wasm:         wasmBytes,
		memoryMB:     memoryMB,
	}
	h.plugins[manifest.ID] = plugin
	h.order = append(h.order, manifest.ID)
	h.dirty = true
	h.logger.Info("plugin installed", "plugin", manifest.ID, "version", manifest.Version)
	return statusOf(plugin), nil
}

// Enable makes an installed plugin live. It is idempotent.
//
// Beta 1.2: the manifest is re-verified before the state changes, so a package
// whose manifest was edited after install (or after the last enable) cannot be
// turned on. The mismatch is sticky: the plugin is marked failed and the reason
// is kept for the management page, while disabling and removing stay possible so
// the operator can always recover.
func (h *Host) Enable(id string) (Status, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	plugin, err := h.lookupLocked(id)
	if err != nil {
		return Status{}, err
	}
	verification, err := VerifyManifest(plugin.Dir)
	if err != nil {
		return Status{}, fmt.Errorf("plugins: verify %s: %w", id, err)
	}
	plugin.ManifestHash = reportedManifestHash(verification)
	plugin.Integrity = verification.Integrity
	plugin.VerifiedAt = verification.VerifiedAt
	if verification.Integrity == IntegrityMismatch {
		plugin.State = StateFailed
		plugin.LastError = "manifest integrity mismatch: " + verification.Reason
		h.dirty = true
		h.logger.Warn("refusing to enable a plugin with a modified manifest",
			"plugin", id, "reason", verification.Reason)
		return Status{}, fmt.Errorf("%w: %s: %s", ErrIntegrityMismatch, id, verification.Reason)
	}
	if plugin.State == StateEnabled {
		return statusOf(plugin), nil
	}
	plugin.State = StateEnabled
	plugin.LastError = ""
	plugin.EnabledAt = time.Now().UTC()
	h.dirty = true
	h.logger.Info("plugin enabled", "plugin", id)
	return statusOf(plugin), nil
}

// Disable stops a plugin without removing it.
func (h *Host) Disable(id string) (Status, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	plugin, err := h.lookupLocked(id)
	if err != nil {
		return Status{}, err
	}
	if plugin.State != StateEnabled {
		plugin.State = StateDisabled
		h.dirty = true
		return statusOf(plugin), nil
	}
	plugin.State = StateDisabled
	h.dirty = true
	h.logger.Info("plugin disabled", "plugin", id)
	return statusOf(plugin), nil
}

// Remove unloads and deletes an installed plugin.
func (h *Host) Remove(id string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	plugin, err := h.lookupLocked(id)
	if err != nil {
		return err
	}
	if plugin.runtime != nil {
		_ = plugin.runtime.Close(context.Background())
		plugin.runtime = nil
	}
	plugin.compiled = nil
	delete(h.plugins, id)
	for index, candidate := range h.order {
		if candidate == id {
			h.order = append(h.order[:index], h.order[index+1:]...)
			break
		}
	}
	h.dirty = true
	h.logger.Info("plugin removed", "plugin", id)
	return nil
}

// List returns every installed plugin in installation order.
func (h *Host) List() []Status {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]Status, 0, len(h.order))
	for _, id := range h.order {
		if plugin, ok := h.plugins[id]; ok {
			out = append(out, statusOf(plugin))
		}
	}
	return out
}

// Get returns one plugin's status.
func (h *Host) Get(id string) (Status, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	plugin, ok := h.plugins[id]
	if !ok {
		return Status{}, false
	}
	return statusOf(plugin), true
}

// PublicPlugins returns the enabled plugins the browser may load.
func (h *Host) PublicPlugins() []PublicPlugin {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]PublicPlugin, 0, len(h.order))
	for _, id := range h.order {
		plugin, ok := h.plugins[id]
		if !ok || plugin.State != StateEnabled || plugin.Manifest.Frontend == nil {
			continue
		}
		frontend := plugin.Manifest.Frontend
		entry := path.Base(frontend.Entry)
		styles := make([]string, 0, len(frontend.Styles))
		for _, style := range frontend.Styles {
			styles = append(styles, path.Base(style))
		}
		out = append(out, PublicPlugin{
			ID:          plugin.Manifest.ID,
			Name:        plugin.Manifest.Name,
			Version:     plugin.Manifest.Version,
			Description: plugin.Manifest.Description,
			Entry:       fmt.Sprintf("/plugins/%s/%s/%s", plugin.Manifest.ID, plugin.Manifest.Version, entry),
			Styles:      styles,
			Slots:       append([]string(nil), frontend.Slots...),
			Blocks:      append([]BlockSpec(nil), frontend.Blocks...),
			Permissions: SortedPermissionList(plugin.Manifest.Permissions),
			Integrity:   frontend.Integrity,
			Settings:    len(plugin.Manifest.SettingsSchema) > 0,
			// Beta 1.2: the boot record now carries the manifest digest recorded at
			// install, so a browser or an operator can correlate the running bundle
			// with the package the server verified. It was declared on the struct
			// but never assigned before this fix.
			ManifestHash: plugin.ManifestHash,
		})
	}
	return out
}

// TransformHTML runs the content.render hook chain.
//
// A failing plugin is reported in the result slice and skipped; one broken
// plugin must not take the article down. The caller decides whether to log,
// alert, or fail closed. The returned HTML is always the best available value.
func (h *Host) TransformHTML(ctx context.Context, payload HookPayload) (string, []HookResult) {
	// The read lock is held for the whole chain: Remove closes the compiled
	// module, so an invocation must never outlive the lock that protects it.
	h.mu.RLock()
	defer h.mu.RUnlock()

	targets := make([]*Plugin, 0, len(h.order))
	for _, id := range h.order {
		plugin, ok := h.plugins[id]
		if !ok || plugin.State != StateEnabled || plugin.Manifest.Backend == nil {
			continue
		}
		if !contains(plugin.Manifest.Backend.Hooks, "content.render") {
			continue
		}
		targets = append(targets, plugin)
	}

	html := payload.HTML
	results := make([]HookResult, 0, len(targets))
	for _, plugin := range targets {
		next := payload
		next.HTML = html
		result, err := h.invokeHook(ctx, plugin, "content.render", next)
		if err != nil {
			results = append(results, HookResult{PluginID: plugin.Manifest.ID, Error: err})
			h.logger.Warn("plugin content hook failed", "plugin", plugin.Manifest.ID, "error", err)
			continue
		}
		var answer struct {
			HTML string `json:"html"`
		}
		if err := json.Unmarshal(result, &answer); err != nil {
			results = append(results, HookResult{PluginID: plugin.Manifest.ID, Error: fmt.Errorf("decode hook result: %w", err)})
			continue
		}
		if len(answer.HTML) > MaxHookHTMLBytes {
			results = append(results, HookResult{PluginID: plugin.Manifest.ID, Error: errors.New("hook result exceeds size limit")})
			continue
		}
		html = answer.HTML
		results = append(results, HookResult{PluginID: plugin.Manifest.ID, HTML: html})
	}
	return html, results
}

// invokeHook wraps one hook invocation in the ABI request and decodes the
// plugin's result envelope.
func (h *Host) invokeHook(ctx context.Context, plugin *Plugin, hook string, payload any) (json.RawMessage, error) {
	if plugin.compiled == nil {
		return nil, errors.New("plugin has no compiled backend")
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode hook payload: %w", err)
	}
	request := wasmRequest{
		ABI:          "wasi-json-v1",
		PluginID:     plugin.Manifest.ID,
		Version:      plugin.Manifest.Version,
		Hook:         hook,
		Payload:      raw,
		Capabilities: SortedPermissionList(plugin.Manifest.Permissions),
	}
	return h.invoke(ctx, plugin, request)
}

type wasmRequest struct {
	ABI          string          `json:"abi"`
	PluginID     string          `json:"plugin_id"`
	Version      string          `json:"version"`
	Hook         string          `json:"hook,omitempty"`
	Route        string          `json:"route,omitempty"`
	Handler      string          `json:"handler,omitempty"`
	Payload      json.RawMessage `json:"payload,omitempty"`
	Capabilities []string        `json:"capabilities,omitempty"`
}

type wasmResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (h *Host) invoke(ctx context.Context, plugin *Plugin, request wasmRequest) (json.RawMessage, error) {
	if plugin.runtime == nil || plugin.compiled == nil {
		return nil, fmt.Errorf("plugin %s is not runnable", plugin.Manifest.ID)
	}
	timeout := h.options.DefaultTimeout
	if plugin.Manifest.Backend != nil && plugin.Manifest.Backend.TimeoutMS > 0 {
		timeout = time.Duration(plugin.Manifest.Backend.TimeoutMS) * time.Millisecond
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	body, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("encode plugin request: %w", err)
	}
	stdout := &cappedBuffer{max: MaxResponseBody}
	stderr := &cappedBuffer{max: MaxStderrBytes}
	config := wazero.NewModuleConfig().
		WithName(fmt.Sprintf("%s-%d", plugin.Manifest.ID, h.moduleSeq.Add(1))).
		WithStdin(bytes.NewReader(body)).
		WithStdout(stdout).
		WithStderr(stderr).
		WithArgs("pp-plugin").
		WithSysWalltime().
		WithSysNanotime().
		WithSysNanosleep().
		WithStartFunctions("_start")

	type outcome struct {
		err error
	}
	// InstantiateModule blocks inside the guest's _start. A WASI clock sleep or
	// an infinite loop is not guaranteed to observe the Go context, so the
	// call runs in its own goroutine and the deadline closes this plugin's
	// runtime. That is the only reliable way to terminate a guest without
	// touching another plugin.
	done := make(chan outcome, 1)
	go func() {
		instance, instantiateErr := plugin.runtime.InstantiateModule(requestCtx, plugin.compiled, config)
		if instance != nil {
			_ = instance.Close(context.Background())
		}
		done <- outcome{err: instantiateErr}
	}()

	select {
	case result := <-done:
		if result.err != nil {
			if errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
				return nil, fmt.Errorf("plugin %s timed out after %s", plugin.Manifest.ID, timeout)
			}
			return nil, fmt.Errorf("plugin %s failed: %w", plugin.Manifest.ID, result.err)
		}
	case <-requestCtx.Done():
		if errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
			_ = plugin.runtime.Close(context.Background())
			return nil, fmt.Errorf("plugin %s timed out after %s", plugin.Manifest.ID, timeout)
		}
		_ = plugin.runtime.Close(context.Background())
		return nil, fmt.Errorf("plugin %s was cancelled: %w", plugin.Manifest.ID, requestCtx.Err())
	}

	if stdout.overflow {
		return nil, fmt.Errorf("plugin %s exceeded the %d byte response limit", plugin.Manifest.ID, MaxResponseBody)
	}
	var response wasmResponse
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		return nil, fmt.Errorf("plugin %s returned invalid JSON: %w (stderr: %s)", plugin.Manifest.ID, err, truncate(stderr.String(), 256))
	}
	if !response.OK {
		message := "plugin returned an error"
		code := "plugin_error"
		if response.Error != nil {
			if response.Error.Message != "" {
				message = response.Error.Message
			}
			if response.Error.Code != "" {
				code = response.Error.Code
			}
		}
		return nil, fmt.Errorf("plugin %s: %s (%s)", plugin.Manifest.ID, message, code)
	}
	return response.Result, nil
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max] + "..."
}

// cappedBuffer keeps at most max bytes and remembers that it overflowed. It
// accepts the extra bytes so a writing plugin is not aborted mid-call; the host
// rejects the result afterwards.
type cappedBuffer struct {
	buffer   bytes.Buffer
	max      int
	overflow bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > b.max {
		b.overflow = true
		remaining := b.max - b.buffer.Len()
		if remaining > 0 {
			_, _ = b.buffer.Write(p[:remaining])
		}
		return len(p), nil
	}
	return b.buffer.Write(p)
}

func (b *cappedBuffer) Bytes() []byte  { return b.buffer.Bytes() }
func (b *cappedBuffer) String() string { return b.buffer.String() }

func (h *Host) lookupLocked(id string) (*Plugin, error) {
	plugin, ok := h.plugins[id]
	if !ok {
		return nil, fmt.Errorf("plugins: %s is not installed", id)
	}
	return plugin, nil
}

func statusOf(plugin *Plugin) Status {
	return Status{
		ID:           plugin.Manifest.ID,
		Name:         plugin.Manifest.Name,
		Version:      plugin.Manifest.Version,
		State:        plugin.State,
		Runtime:      plugin.Manifest.Runtime,
		Permissions:  SortedPermissionList(plugin.Manifest.Permissions),
		LastError:    plugin.LastError,
		Installed:    plugin.Installed,
		EnabledAt:    plugin.EnabledAt,
		ManifestHash: plugin.ManifestHash,
		Integrity:    plugin.Integrity,
		VerifiedAt:   plugin.VerifiedAt,
	}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// --- HTTP handlers ---------------------------------------------------------

// APIHandler serves plugin routes. Mount it under a prefix the host owns, for
// example /api/v1/plugins/; the handler strips that prefix itself so it does not
// depend on a router's wildcard syntax.
func (h *Host) APIHandler(prefix string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, prefix) {
			writePluginProblem(w, http.StatusNotFound, "plugin_not_found", "unknown plugin route")
			return
		}
		remainder := strings.TrimPrefix(r.URL.Path, prefix)
		id, routePath := splitFirst(remainder)
		if id == "" || routePath == "" {
			writePluginProblem(w, http.StatusNotFound, "plugin_not_found", "unknown plugin route")
			return
		}
		routePath = "/" + strings.TrimPrefix(routePath, "/")

		h.mu.RLock()
		plugin, ok := h.plugins[id]
		var route Route
		state := StateInstalled
		if ok {
			state = plugin.State
			route, ok = findRoute(plugin.Manifest, r.Method, routePath)
		}
		h.mu.RUnlock()
		if !ok || state != StateEnabled {
			writePluginProblem(w, http.StatusNotFound, "plugin_not_found", "plugin route is not available")
			return
		}

		info := RequestInfoFrom(r.Context())
		if status, code, detail := authorizeRoute(route, info); status != 0 {
			writePluginProblem(w, status, code, detail)
			return
		}

		body := io.Reader(http.NoBody)
		if r.Body != nil {
			body = r.Body
		}
		payloadBytes, err := io.ReadAll(io.LimitReader(body, MaxRequestBodyBytes+1))
		if err != nil {
			writePluginProblem(w, http.StatusBadRequest, "bad_request", "could not read request body")
			return
		}
		if len(payloadBytes) > MaxRequestBodyBytes {
			writePluginProblem(w, http.StatusRequestEntityTooLarge, "request_too_large", "plugin request body exceeds 1 MiB")
			return
		}
		payload := map[string]any{
			"method":  r.Method,
			"path":    routePath,
			"query":   r.URL.Query(),
			"headers": allowedRequestHeaders(r.Header),
			"body":    string(payloadBytes),
			"site_id": info.SiteID,
			"user_id": info.UserID,
			"role":    info.Role,
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			writePluginProblem(w, http.StatusInternalServerError, "plugin_error", "could not encode request")
			return
		}
		h.mu.RLock()
		current := h.plugins[id]
		if current == nil || current.State != StateEnabled {
			h.mu.RUnlock()
			writePluginProblem(w, http.StatusNotFound, "plugin_not_found", "plugin was disabled during the request")
			return
		}
		result, err := h.invoke(r.Context(), current, wasmRequest{
			ABI:          "wasi-json-v1",
			PluginID:     id,
			Version:      current.Manifest.Version,
			Route:        route.Path,
			Handler:      route.Handler,
			Payload:      raw,
			Capabilities: SortedPermissionList(current.Manifest.Permissions),
		})
		h.mu.RUnlock()
		if err != nil {
			h.logger.Warn("plugin route failed", "plugin", id, "route", routePath, "error", err)
			writePluginProblem(w, http.StatusBadGateway, "plugin_error", "plugin failed to handle the request")
			return
		}
		var response struct {
			Status  int               `json:"status"`
			Headers map[string]string `json:"headers"`
			Body    string            `json:"body"`
		}
		if err := json.Unmarshal(result, &response); err != nil {
			writePluginProblem(w, http.StatusBadGateway, "plugin_error", "plugin returned an invalid response")
			return
		}
		if response.Status < 200 || response.Status > 599 {
			response.Status = http.StatusBadGateway
		}
		if len(response.Body) > MaxResponseBody {
			writePluginProblem(w, http.StatusBadGateway, "plugin_error", "plugin response exceeds 4 MiB")
			return
		}
		for name, value := range response.Headers {
			if !allowedResponseHeader(name) {
				continue
			}
			if name == "Location" && !strings.HasPrefix(value, "/") {
				continue
			}
			w.Header().Set(name, value)
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if w.Header().Get("Content-Type") == "" {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
		}
		w.WriteHeader(response.Status)
		_, _ = io.WriteString(w, response.Body)
	})
}

// AssetHandler serves the declared browser bundles. Mount it at
// /plugins/<id>/<version>/; only files under the plugin's frontend directory
// are reachable and only for an enabled plugin.
func (h *Host) AssetHandler(prefix string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !strings.HasPrefix(r.URL.Path, prefix) {
			http.NotFound(w, r)
			return
		}
		remainder := strings.TrimPrefix(r.URL.Path, prefix)
		id, rest := splitFirst(remainder)
		version, file := splitFirst(rest)
		if id == "" || version == "" || file == "" {
			http.NotFound(w, r)
			return
		}

		var pluginDir, pluginVersion string
		h.mu.RLock()
		if plugin, ok := h.plugins[id]; ok &&
			plugin.State == StateEnabled &&
			plugin.Manifest.Frontend != nil &&
			plugin.Manifest.Version == version {
			pluginDir = plugin.Dir
			pluginVersion = plugin.Manifest.Version
		}
		h.mu.RUnlock()
		if pluginDir == "" || pluginVersion != version {
			http.NotFound(w, r)
			return
		}
		clean := path.Clean("/" + file)
		if strings.Contains(clean, "..") || clean == "/" {
			http.NotFound(w, r)
			return
		}
		relative := strings.TrimPrefix(clean, "/")
		full := filepath.Join(pluginDir, "frontend", filepath.FromSlash(relative))
		info, err := os.Stat(full)
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		contentType := contentTypeFor(relative)
		if contentType == "" {
			http.NotFound(w, r)
			return
		}
		etag := fmt.Sprintf(`"%s-%d-%d"`, pluginVersion, info.Size(), info.ModTime().UnixNano())
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasSuffix(strings.ToLower(relative), ".svg") {
			w.Header().Set("Content-Security-Policy", "script-src 'none'")
		}
		if match := r.Header.Get("If-None-Match"); match == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", contentType)
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		fileHandle, err := os.Open(full)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer fileHandle.Close()
		_, _ = io.Copy(w, io.LimitReader(fileHandle, 16<<20))
	})
}

func authorizeRoute(route Route, info RequestInfo) (int, string, string) {
	auth := route.Auth
	if auth == "" {
		auth = "public"
	}
	switch auth {
	case "public":
		return 0, "", ""
	case "member":
		if !info.Authenticated {
			return http.StatusUnauthorized, "unauthenticated", "this plugin route requires a member session"
		}
		return 0, "", ""
	case "admin":
		if !info.Authenticated {
			return http.StatusUnauthorized, "unauthenticated", "this plugin route requires a site administrator"
		}
		if info.Role != "site_admin" && info.Role != "platform_admin" {
			return http.StatusForbidden, "forbidden", "this plugin route requires a site administrator"
		}
		return 0, "", ""
	default:
		return http.StatusForbidden, "forbidden", "unknown route policy"
	}
}

func findRoute(manifest Manifest, method, routePath string) (Route, bool) {
	if manifest.Backend == nil {
		return Route{}, false
	}
	for _, route := range manifest.Backend.Routes {
		candidateMethod := route.Method
		if candidateMethod == "" {
			candidateMethod = http.MethodGet
		}
		if candidateMethod != method {
			continue
		}
		if route.Path == routePath {
			return route, true
		}
	}
	return Route{}, false
}

func allowedRequestHeaders(headers http.Header) map[string]string {
	out := make(map[string]string, 4)
	for _, name := range []string{"Accept", "Accept-Language", "Content-Type", "User-Agent", "X-Requested-With"} {
		if value := headers.Get(name); value != "" {
			if len(value) > 1024 {
				value = value[:1024]
			}
			out[http.CanonicalHeaderKey(name)] = value
		}
	}
	return out
}

func allowedResponseHeader(name string) bool {
	switch http.CanonicalHeaderKey(name) {
	case "Content-Type", "Cache-Control", "ETag", "Location", "Content-Language":
		return true
	default:
		return strings.HasPrefix(http.CanonicalHeaderKey(name), "X-Pp-")
	}
}

func contentTypeFor(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".woff2":
		return "font/woff2"
	case ".txt", ".md":
		return "text/plain; charset=utf-8"
	default:
		if detected := mime.TypeByExtension(strings.ToLower(path.Ext(name))); detected != "" {
			return detected
		}
		return ""
	}
}

func writePluginProblem(w http.ResponseWriter, status int, code, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type":   "about:blank",
		"title":  http.StatusText(status),
		"status": status,
		"code":   code,
		"detail": detail,
	})
}

func splitFirst(value string) (string, string) {
	index := strings.IndexByte(value, '/')
	if index < 0 {
		return value, ""
	}
	return value[:index], value[index+1:]
}

// SortedList is a small helper used by tests and by the status endpoint.
func SortedList(values []string) []string {
	out := append([]string(nil), values...)
	sort.Strings(out)
	return out
}
