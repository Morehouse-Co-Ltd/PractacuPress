// Package plugins is the server-side plugin host for Practacu Press.
//
// The package is deliberately transport agnostic: a plugin is described by a
// manifest, executed in a WebAssembly sandbox (wazero), and reached by the HTTP
// layer through two narrow handlers. Nothing here imports gin, ent or the
// application services, so the host can be unit tested without a database and
// reused by a future CLI.
//
// Trust model (see docs/design/2026-11-10-pp-plugin-architecture.md):
//   - A WASM plugin is untrusted code. It gets stdin/stdout for the duration of
//     one invocation, a bounded output buffer and a context deadline. It gets no
//     filesystem, network, environment or host functions unless a future ABI
//     version adds them behind an explicit capability.
//   - The manifest is the capability grant. A plugin that asks for a route
//     without http.route.* is rejected at install time; it cannot self-grant.
//   - This package is not a trust boundary for a compiled Go plugin. A native
//     plugin linked into the binary runs with the process's full authority.
package plugins

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ManifestVersion is the only manifest format this host understands.
const ManifestVersion = 1

// ManifestFileName is the file a plugin directory must contain.
const ManifestFileName = "plugin.json"

// MaxManifestBytes bounds one manifest. A manifest is metadata, never content.
const MaxManifestBytes = 256 << 10

// MaxContractBytes bounds a single route's OpenAPI operation object.
const MaxContractBytes = 64 << 10

// ErrInvalidManifest marks every rejected manifest. Callers use errors.Is to
// distinguish "the operator installed a broken package" from an I/O failure.
var ErrInvalidManifest = errors.New("plugins: invalid manifest")

// Engines declares the host and contract versions a plugin needs.
type Engines struct {
	// PP is the Practacu Press host version range, for example ">=0.1.0 <1.0.0".
	PP string `json:"pp"`
	// Contract is the OpenAPI contract version range. Omitted means any.
	Contract string `json:"contract,omitempty"`
}

// Backend describes the server half of a plugin.
type Backend struct {
	// Entry is the .wasm file, relative to the plugin directory.
	Entry string `json:"entry"`
	// ABI selects the invocation protocol. Only "wasi-json-v1" is supported.
	ABI string `json:"abi"`
	// TimeoutMS bounds one invocation. Zero uses the host default.
	TimeoutMS int `json:"timeout_ms,omitempty"`
	// MaxMemoryMB caps linear memory. Zero uses the host default.
	MaxMemoryMB int `json:"max_memory_mb,omitempty"`
	// Hooks are the lifecycle events the plugin subscribes to.
	Hooks []string `json:"hooks,omitempty"`
	// Routes are HTTP endpoints mounted under /api/v1/plugins/<id>.
	Routes []Route `json:"routes,omitempty"`
}

// Route is one HTTP endpoint served by a plugin.
type Route struct {
	Method string `json:"method"`
	// Path is relative to the plugin namespace and must start with "/".
	Path string `json:"path"`
	// Handler is passed to the plugin so one module can serve several routes.
	Handler string `json:"handler,omitempty"`
	// Auth is "public", "member" or "admin". Defaults to "public".
	Auth string `json:"auth,omitempty"`
	// Contract is the OpenAPI operation object for this route. Required: a
	// plugin route that is not documented is invisible to every client.
	Contract json.RawMessage `json:"contract"`
}

// Frontend describes the browser half served from /plugins/<id>/<version>/.
type Frontend struct {
	// Entry is the browser bundle, relative to the plugin directory.
	Entry string `json:"entry"`
	// Styles are CSS files loaded with the bundle.
	Styles []string `json:"styles,omitempty"`
	// Slots are the named UI seats this plugin may fill.
	Slots []string `json:"slots,omitempty"`
	// Blocks are the content block types this plugin may render.
	Blocks []BlockSpec `json:"blocks,omitempty"`
	// Integrity is an optional SRI hash ("sha384-...") for the entry bundle.
	Integrity string `json:"integrity,omitempty"`
}

// BlockSpec declares one content block type contributed by a plugin.
//
// The browser renders the block, but the page builder also needs to know how to
// present it: the name and description in the palette, which layout variants may
// use it, its default column area, the props a fresh block starts with and the
// property schema the inspector renders. Keeping that metadata in the signed-off
// manifest means a bundle cannot relabel itself at activation time.
type BlockSpec struct {
	Type string `json:"type"`
	Name string `json:"name,omitempty"`
	// Description is one sentence shown in the palette tooltip.
	Description string `json:"description,omitempty"`
	// Group is a presentation hint: shared, classic, nightflight or content.
	Group string `json:"group,omitempty"`
	// Variants lists the layout variants the palette offers this block in.
	Variants []string `json:"variants,omitempty"`
	// Area is the default two-column placement: full, main or side.
	Area string `json:"area,omitempty"`
	// Defaults seeds props when the builder inserts a new block. Object only.
	Defaults json.RawMessage `json:"defaults,omitempty"`
	// Schema is the property inspector declaration (array of PropSchema).
	Schema json.RawMessage `json:"schema,omitempty"`
}

// Manifest is one plugin's declarative contract with the host.
type Manifest struct {
	ManifestVersion int             `json:"manifest_version"`
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Version         string          `json:"version"`
	Description     string          `json:"description,omitempty"`
	Author          string          `json:"author,omitempty"`
	License         string          `json:"license,omitempty"`
	Homepage        string          `json:"homepage,omitempty"`
	Engines         Engines         `json:"engines"`
	Runtime         string          `json:"runtime"`
	Backend         *Backend        `json:"backend,omitempty"`
	Frontend        *Frontend       `json:"frontend,omitempty"`
	Permissions     []string        `json:"permissions,omitempty"`
	SettingsSchema  json.RawMessage `json:"settings_schema,omitempty"`
}

// Permission is one capability a manifest may request.
type Permission string

const (
	// PermContentRead allows a hook to receive content bodies and metadata.
	PermContentRead Permission = "content.read"
	// PermContentRender allows the plugin to transform rendered HTML.
	PermContentRender Permission = "content.render"
	// PermContentWrite allows content lifecycle hooks (create/update/publish).
	PermContentWrite Permission = "content.write"
	// PermHTTPPublic allows a public route.
	PermHTTPPublic Permission = "http.route.public"
	// PermHTTPMember allows a route that requires an authenticated member.
	PermHTTPMember Permission = "http.route.member"
	// PermAdminRoute allows a route that requires a site administrator.
	PermAdminRoute Permission = "admin.route"
	// PermUIInject allows the browser half to occupy declared UI slots.
	PermUIInject Permission = "ui.inject"
	// PermUIBlock allows the browser half to render declared block types.
	PermUIBlock Permission = "ui.block"
	// PermUIStyle allows the browser half to inject scoped CSS.
	PermUIStyle Permission = "ui.style"
)

// knownPermissions is the closed vocabulary of manifest permissions. Adding a
// value here is a security review item, not a formatting change.
var knownPermissions = map[Permission]struct{}{
	PermContentRead:   {},
	PermContentRender: {},
	PermContentWrite:  {},
	PermHTTPPublic:    {},
	PermHTTPMember:    {},
	PermAdminRoute:    {},
	PermUIInject:      {},
	PermUIBlock:       {},
	PermUIStyle:       {},
}

// knownHooks is the closed server hook vocabulary of ABI v1.
var knownHooks = map[string]Permission{
	"content.render":       PermContentRender,
	"content.after_create": PermContentWrite,
	"content.after_update": PermContentWrite,
	"content.after_delete": PermContentWrite,
}

// knownSlots is the closed UI slot vocabulary of the browser runtime. A plugin
// may only register into a slot it declared and the host knows.
var knownSlots = map[string]struct{}{
	"site.header":        {},
	"site.footer":        {},
	"article.after":      {},
	"article.sidebar":    {},
	"home.after":         {},
	"admin.nav":          {},
	"admin.settings":     {},
	"admin.editor.tools": {},
}

var (
	idPattern      = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`)
	versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
	routePattern   = regexp.MustCompile(`^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,160}$`)
)

// LoadManifest reads and validates one plugin directory.
//
// Validation is intentionally strict and happens before any code is compiled:
// a manifest that asks for capabilities its shape cannot use is a bug in the
// package, and failing at install time is cheaper than failing in production.
func LoadManifest(dir string) (Manifest, error) {
	raw, err := os.ReadFile(filepath.Join(dir, ManifestFileName))
	if err != nil {
		return Manifest{}, fmt.Errorf("plugins: read manifest: %w", err)
	}
	if len(raw) > MaxManifestBytes {
		return Manifest{}, fmt.Errorf("%w: manifest exceeds %d bytes", ErrInvalidManifest, MaxManifestBytes)
	}
	var manifest Manifest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("%w: decode: %v", ErrInvalidManifest, err)
	}
	if err := ValidateManifest(manifest, dir); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// ValidateManifest checks a decoded manifest and the files it references.
//
// dir may be empty when only the shape is validated (tests, tooling). When dir
// is set, every declared entry must be a regular file inside it.
func ValidateManifest(m Manifest, dir string) error {
	if m.ManifestVersion != ManifestVersion {
		return fmt.Errorf("%w: manifest_version must be %d", ErrInvalidManifest, ManifestVersion)
	}
	if !idPattern.MatchString(m.ID) || len(m.ID) < 3 || len(m.ID) > 64 {
		return fmt.Errorf("%w: id %q must be a lowercase reverse-DNS identifier", ErrInvalidManifest, m.ID)
	}
	if strings.TrimSpace(m.Name) == "" || len([]rune(m.Name)) > 80 {
		return fmt.Errorf("%w: name is required and must be at most 80 characters", ErrInvalidManifest)
	}
	if !versionPattern.MatchString(m.Version) {
		return fmt.Errorf("%w: version %q is not semver", ErrInvalidManifest, m.Version)
	}
	if m.Engines.PP == "" {
		return fmt.Errorf("%w: engines.pp is required", ErrInvalidManifest)
	}
	if err := validateRange(m.Engines.PP); err != nil {
		return fmt.Errorf("%w: engines.pp: %v", ErrInvalidManifest, err)
	}
	if m.Engines.Contract != "" {
		if err := validateRange(m.Engines.Contract); err != nil {
			return fmt.Errorf("%w: engines.contract: %v", ErrInvalidManifest, err)
		}
	}

	switch m.Runtime {
	case "wasm":
		if m.Backend == nil {
			return fmt.Errorf("%w: runtime wasm requires a backend", ErrInvalidManifest)
		}
	case "none":
		if m.Backend != nil {
			return fmt.Errorf("%w: runtime none must not declare a backend", ErrInvalidManifest)
		}
	default:
		return fmt.Errorf("%w: runtime must be \"wasm\" or \"none\"", ErrInvalidManifest)
	}

	permissions := make(map[Permission]struct{}, len(m.Permissions))
	for _, raw := range m.Permissions {
		permission := Permission(raw)
		if _, ok := knownPermissions[permission]; !ok {
			return fmt.Errorf("%w: unknown permission %q", ErrInvalidManifest, raw)
		}
		permissions[permission] = struct{}{}
	}

	if m.SettingsSchema != nil {
		var schema map[string]any
		if err := json.Unmarshal(m.SettingsSchema, &schema); err != nil {
			return fmt.Errorf("%w: settings_schema must be a JSON object", ErrInvalidManifest)
		}
	}

	if m.Backend != nil {
		if err := validateBackend(*m.Backend, permissions, dir); err != nil {
			return err
		}
	}
	if m.Frontend != nil {
		if err := validateFrontend(*m.Frontend, permissions, dir); err != nil {
			return err
		}
	}
	return nil
}

func validateBackend(b Backend, permissions map[Permission]struct{}, dir string) error {
	if b.ABI != "wasi-json-v1" {
		return fmt.Errorf("%w: backend.abi must be \"wasi-json-v1\"", ErrInvalidManifest)
	}
	if err := validateFile(b.Entry, dir, ".wasm"); err != nil {
		return fmt.Errorf("%w: backend.entry: %v", ErrInvalidManifest, err)
	}
	if b.TimeoutMS < 0 || b.TimeoutMS > 30_000 {
		return fmt.Errorf("%w: backend.timeout_ms must be between 0 and 30000", ErrInvalidManifest)
	}
	if b.MaxMemoryMB < 0 || b.MaxMemoryMB > 512 {
		return fmt.Errorf("%w: backend.max_memory_mb must be between 0 and 512", ErrInvalidManifest)
	}

	seenRoutes := make(map[string]struct{}, len(b.Routes))
	for _, route := range b.Routes {
		if err := validateRoute(route, permissions); err != nil {
			return err
		}
		key := route.Method + " " + route.Path
		if _, exists := seenRoutes[key]; exists {
			return fmt.Errorf("%w: duplicate route %s", ErrInvalidManifest, key)
		}
		seenRoutes[key] = struct{}{}
	}

	for _, hook := range b.Hooks {
		required, ok := knownHooks[hook]
		if !ok {
			return fmt.Errorf("%w: unknown hook %q", ErrInvalidManifest, hook)
		}
		if _, granted := permissions[required]; !granted {
			return fmt.Errorf("%w: hook %q requires permission %q", ErrInvalidManifest, hook, required)
		}
	}
	return nil
}

func validateRoute(route Route, permissions map[Permission]struct{}) error {
	switch route.Method {
	case "GET", "POST", "PUT", "PATCH", "DELETE":
	default:
		return fmt.Errorf("%w: route method %q is not allowed", ErrInvalidManifest, route.Method)
	}
	if !routePattern.MatchString(route.Path) || strings.Contains(route.Path, "..") {
		return fmt.Errorf("%w: route path %q is not a safe absolute path", ErrInvalidManifest, route.Path)
	}
	auth := route.Auth
	if auth == "" {
		auth = "public"
	}
	switch auth {
	case "public":
		if _, ok := permissions[PermHTTPPublic]; !ok {
			return fmt.Errorf("%w: public route %s requires %q", ErrInvalidManifest, route.Path, PermHTTPPublic)
		}
	case "member":
		if _, ok := permissions[PermHTTPMember]; !ok {
			return fmt.Errorf("%w: member route %s requires %q", ErrInvalidManifest, route.Path, PermHTTPMember)
		}
	case "admin":
		if _, ok := permissions[PermAdminRoute]; !ok {
			return fmt.Errorf("%w: admin route %s requires %q", ErrInvalidManifest, route.Path, PermAdminRoute)
		}
	default:
		return fmt.Errorf("%w: route auth must be public, member or admin", ErrInvalidManifest)
	}
	if len(route.Contract) == 0 {
		return fmt.Errorf("%w: route %s has no contract operation", ErrInvalidManifest, route.Path)
	}
	if len(route.Contract) > MaxContractBytes {
		return fmt.Errorf("%w: route %s contract exceeds %d bytes", ErrInvalidManifest, route.Path, MaxContractBytes)
	}
	var operation map[string]any
	decoder := json.NewDecoder(bytes.NewReader(route.Contract))
	decoder.UseNumber()
	if err := decoder.Decode(&operation); err != nil {
		return fmt.Errorf("%w: route %s contract is not JSON: %v", ErrInvalidManifest, route.Path, err)
	}
	if _, ok := operation["responses"]; !ok {
		return fmt.Errorf("%w: route %s contract has no responses", ErrInvalidManifest, route.Path)
	}
	for _, forbidden := range []string{"servers", "security", "callbacks", "webhooks"} {
		if _, ok := operation[forbidden]; ok {
			return fmt.Errorf("%w: route %s contract may not declare %s", ErrInvalidManifest, route.Path, forbidden)
		}
	}
	if hasRef(operation) {
		return fmt.Errorf("%w: route %s contract may not use $ref in v1; inline the schema", ErrInvalidManifest, route.Path)
	}
	return nil
}

func validateFrontend(f Frontend, permissions map[Permission]struct{}, dir string) error {
	entryPermission := PermUIInject
	if _, ok := permissions[entryPermission]; !ok {
		return fmt.Errorf("%w: a frontend requires %q", ErrInvalidManifest, entryPermission)
	}
	if err := validateFile(f.Entry, dir, ".js"); err != nil {
		return fmt.Errorf("%w: frontend.entry: %v", ErrInvalidManifest, err)
	}
	for _, style := range f.Styles {
		if err := validateFile(style, dir, ".css"); err != nil {
			return fmt.Errorf("%w: frontend.styles: %v", ErrInvalidManifest, err)
		}
		if _, ok := permissions[PermUIStyle]; !ok {
			return fmt.Errorf("%w: a stylesheet requires %q", ErrInvalidManifest, PermUIStyle)
		}
	}
	for _, slot := range f.Slots {
		if _, ok := knownSlots[slot]; !ok {
			return fmt.Errorf("%w: unknown slot %q", ErrInvalidManifest, slot)
		}
	}
	seenBlocks := make(map[string]struct{}, len(f.Blocks))
	if len(f.Blocks) > maxDeclaredBlocks {
		return fmt.Errorf("%w: a frontend may declare at most %d blocks", ErrInvalidManifest, maxDeclaredBlocks)
	}
	for _, block := range f.Blocks {
		if err := validateBlockSpec(block); err != nil {
			return err
		}
		if _, exists := seenBlocks[block.Type]; exists {
			return fmt.Errorf("%w: duplicate block type %q", ErrInvalidManifest, block.Type)
		}
		seenBlocks[block.Type] = struct{}{}
	}
	if len(f.Blocks) > 0 {
		if _, ok := permissions[PermUIBlock]; !ok {
			return fmt.Errorf("%w: declaring blocks requires %q", ErrInvalidManifest, PermUIBlock)
		}
	}
	if f.Integrity != "" && !strings.HasPrefix(f.Integrity, "sha384-") {
		return fmt.Errorf("%w: frontend.integrity must be a sha384 SRI value", ErrInvalidManifest)
	}
	return nil
}

// Block metadata limits. They bound the untrusted manifest before it reaches the
// page builder, which renders the schema as controls and the defaults as props.
const (
	maxDeclaredBlocks     = 32
	blockNameMaxRunes     = 60
	blockDescriptionRunes = 200
	blockDefaultsMaxBytes = 4096
	blockSchemaMaxBytes   = 16 * 1024
	blockSchemaMaxFields  = 40
	blockVariants         = 3
)

// validateBlockSpec checks one declared block. The browser still normalises the
// values it receives; this only rejects what the host must never hand over: bad
// identifiers, oversize JSON, non-scalar defaults and schemas without a field type.
func validateBlockSpec(block BlockSpec) error {
	if !idPattern.MatchString(block.Type) {
		return fmt.Errorf("%w: block type %q must be lowercase kebab/dot", ErrInvalidManifest, block.Type)
	}
	if len([]rune(block.Name)) > blockNameMaxRunes {
		return fmt.Errorf("%w: block %q name is too long", ErrInvalidManifest, block.Type)
	}
	if len([]rune(block.Description)) > blockDescriptionRunes {
		return fmt.Errorf("%w: block %q description is too long", ErrInvalidManifest, block.Type)
	}
	switch block.Group {
	case "", "shared", "classic", "nightflight", "content":
	default:
		return fmt.Errorf("%w: block %q has unknown group %q", ErrInvalidManifest, block.Type, block.Group)
	}
	if len(block.Variants) > blockVariants {
		return fmt.Errorf("%w: block %q declares too many variants", ErrInvalidManifest, block.Type)
	}
	seenVariants := make(map[string]struct{}, len(block.Variants))
	for _, variant := range block.Variants {
		switch variant {
		case "classic", "bento", "daylight":
		default:
			return fmt.Errorf("%w: block %q has unknown variant %q", ErrInvalidManifest, block.Type, variant)
		}
		if _, exists := seenVariants[variant]; exists {
			return fmt.Errorf("%w: block %q repeats variant %q", ErrInvalidManifest, block.Type, variant)
		}
		seenVariants[variant] = struct{}{}
	}
	switch block.Area {
	case "", "full", "main", "side":
	default:
		return fmt.Errorf("%w: block %q has unknown area %q", ErrInvalidManifest, block.Type, block.Area)
	}
	if len(block.Defaults) > 0 {
		if len(block.Defaults) > blockDefaultsMaxBytes {
			return fmt.Errorf("%w: block %q defaults exceed %d bytes", ErrInvalidManifest, block.Type, blockDefaultsMaxBytes)
		}
		var defaults map[string]json.RawMessage
		if err := json.Unmarshal(block.Defaults, &defaults); err != nil {
			return fmt.Errorf("%w: block %q defaults must be a JSON object", ErrInvalidManifest, block.Type)
		}
		for key, raw := range defaults {
			if len(key) == 0 || len(key) > 60 {
				return fmt.Errorf("%w: block %q has an invalid default key", ErrInvalidManifest, block.Type)
			}
			var scalar any
			if err := json.Unmarshal(raw, &scalar); err != nil {
				return fmt.Errorf("%w: block %q default %q is not JSON", ErrInvalidManifest, block.Type, key)
			}
			switch scalar.(type) {
			case string, float64, bool:
			default:
				return fmt.Errorf("%w: block %q default %q must be a scalar", ErrInvalidManifest, block.Type, key)
			}
		}
	}
	if len(block.Schema) > 0 {
		if len(block.Schema) > blockSchemaMaxBytes {
			return fmt.Errorf("%w: block %q schema exceeds %d bytes", ErrInvalidManifest, block.Type, blockSchemaMaxBytes)
		}
		var fields []json.RawMessage
		if err := json.Unmarshal(block.Schema, &fields); err != nil {
			return fmt.Errorf("%w: block %q schema must be a JSON array", ErrInvalidManifest, block.Type)
		}
		if len(fields) > blockSchemaMaxFields {
			return fmt.Errorf("%w: block %q schema has too many fields", ErrInvalidManifest, block.Type)
		}
		for _, raw := range fields {
			var field struct {
				Key   string `json:"key"`
				Label string `json:"label"`
				Type  string `json:"type"`
			}
			if err := json.Unmarshal(raw, &field); err != nil {
				return fmt.Errorf("%w: block %q schema entry is not an object", ErrInvalidManifest, block.Type)
			}
			if field.Key == "" || field.Type == "" {
				return fmt.Errorf("%w: block %q schema entries need key and type", ErrInvalidManifest, block.Type)
			}
		}
	}
	return nil
}

func validateFile(rel, dir, suffix string) error {
	if rel == "" {
		return errors.New("path is empty")
	}
	if filepath.IsAbs(rel) || strings.ContainsAny(rel, `\:`) {
		return fmt.Errorf("%q must be a relative slash-separated path", rel)
	}
	clean := filepath.ToSlash(filepath.Clean(rel))
	if clean == "." || strings.HasPrefix(clean, "../") || clean == ".." {
		return fmt.Errorf("%q escapes the plugin directory", rel)
	}
	if !strings.HasSuffix(clean, suffix) {
		return fmt.Errorf("%q must end with %s", rel, suffix)
	}
	if dir == "" {
		return nil
	}
	info, err := os.Stat(filepath.Join(dir, filepath.FromSlash(clean)))
	if err != nil {
		return fmt.Errorf("%q: %w", rel, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%q is not a regular file", rel)
	}
	return nil
}

// hasRef reports whether an operation object contains a $ref anywhere.
func hasRef(value any) bool {
	switch node := value.(type) {
	case map[string]any:
		for key, child := range node {
			if key == "$ref" {
				return true
			}
			if hasRef(child) {
				return true
			}
		}
	case []any:
		for _, child := range node {
			if hasRef(child) {
				return true
			}
		}
	}
	return false
}

// --- minimal semver ranges -------------------------------------------------

// validateRange accepts the small grammar this host implements. Keeping the
// grammar small is intentional: a range language with implicit coercion is a
// compatibility trap, and the host only needs "compatible with this release".
func validateRange(raw string) error {
	constraints, err := parseRange(raw)
	if err != nil {
		return err
	}
	if len(constraints) == 0 {
		return errors.New("range is empty")
	}
	return nil
}

type constraint struct {
	op      string
	version [3]int
}

func parseRange(raw string) ([]constraint, error) {
	fields := strings.Fields(strings.ReplaceAll(raw, ",", " "))
	if len(fields) == 0 {
		return nil, errors.New("range is empty")
	}
	var out []constraint
	for _, field := range fields {
		op := "="
		for _, candidate := range []string{">=", "<=", ">", "<", "=", "^", "~"} {
			if strings.HasPrefix(field, candidate) {
				op = candidate
				field = strings.TrimPrefix(field, candidate)
				break
			}
		}
		version, err := parseVersion(field)
		if err != nil {
			return nil, err
		}
		out = append(out, constraint{op: op, version: version})
	}
	return out, nil
}

func parseVersion(raw string) ([3]int, error) {
	var out [3]int
	core := raw
	if index := strings.IndexAny(core, "-+"); index >= 0 {
		core = core[:index]
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return out, fmt.Errorf("%q is not a major.minor.patch version", raw)
	}
	for index, part := range parts {
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 {
			return out, fmt.Errorf("%q is not a major.minor.patch version", raw)
		}
		out[index] = number
	}
	return out, nil
}

// Satisfies reports whether version is inside the supported range grammar.
func Satisfies(version, rawRange string) bool {
	current, err := parseVersion(version)
	if err != nil {
		return false
	}
	constraints, err := parseRange(rawRange)
	if err != nil {
		return false
	}
	for _, c := range constraints {
		cmp := compareVersion(current, c.version)
		switch c.op {
		case "=":
			if cmp != 0 {
				return false
			}
		case ">":
			if cmp <= 0 {
				return false
			}
		case ">=":
			if cmp < 0 {
				return false
			}
		case "<":
			if cmp >= 0 {
				return false
			}
		case "<=":
			if cmp > 0 {
				return false
			}
		case "^":
			if cmp < 0 || current[0] != c.version[0] {
				return false
			}
		case "~":
			if cmp < 0 || current[0] != c.version[0] || current[1] != c.version[1] {
				return false
			}
		}
	}
	return true
}

func compareVersion(a, b [3]int) int {
	for index := 0; index < 3; index++ {
		if a[index] < b[index] {
			return -1
		}
		if a[index] > b[index] {
			return 1
		}
	}
	return 0
}

// SortedPermissionList returns the manifest permissions in stable order. It is
// used by the public status projection so two hosts with the same grants show
// the same list.
func SortedPermissionList(permissions []string) []string {
	seen := make(map[string]struct{}, len(permissions))
	out := make([]string, 0, len(permissions))
	for _, permission := range permissions {
		if _, ok := seen[permission]; ok {
			continue
		}
		seen[permission] = struct{}{}
		out = append(out, permission)
	}
	sort.Strings(out)
	return out
}
