package extensions

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/plugins"
)

// newTestHost builds a host for one test. The manager closes it too; Close is
// idempotent, so the cleanup order does not matter.
func newTestHost(t *testing.T) *plugins.Host {
	t.Helper()
	host, err := plugins.New(plugins.Options{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = host.Close() })
	return host
}

// newTestManager builds a manager over a fresh data directory.
func newTestManager(t *testing.T, dataDir string, tweak func(*Options)) *Manager {
	t.Helper()
	options := Options{Host: newTestHost(t), DataDir: dataDir}
	if tweak != nil {
		tweak(&options)
	}
	manager, err := NewManager(options)
	require.NoError(t, err)
	t.Cleanup(func() { _ = manager.Close() })
	return manager
}

func writeFile(t *testing.T, path string, data string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(data), 0o644))
}

// frontendManifest is a valid runtime "none" package: a browser half only.
func frontendManifest(id, version string) string {
	return `{
  "manifest_version": 1,
  "id": "` + id + `",
  "name": "Frontend ` + id + `",
  "version": "` + version + `",
  "description": "A browser-only extension.",
  "author": "Practacu Press",
  "license": "MIT",
  "homepage": "https://example.com/` + id + `",
  "engines": {"pp": ">=0.1.0 <1.0.0"},
  "runtime": "none",
  "frontend": {
    "entry": "frontend/client.js",
    "styles": ["frontend/client.css"],
    "slots": ["article.after"],
    "blocks": [{"type": "frontend.card", "name": "Card"}]
  },
  "permissions": ["ui.inject", "ui.style", "ui.block"]
}`
}

// writeFrontendPackage creates one browser-only package directory.
func writeFrontendPackage(t *testing.T, dir, id, version string) {
	t.Helper()
	writeFile(t, filepath.Join(dir, plugins.ManifestFileName), frontendManifest(id, version))
	writeFile(t, filepath.Join(dir, "frontend", "client.js"), "window.__PP_PLUGIN_REGISTER__('"+id+"','"+version+"',function(){});")
	writeFile(t, filepath.Join(dir, "frontend", "client.css"), ".frontend-card{color:red}")
}

type archiveEntry struct {
	name string
	data string
	mode fs.FileMode
}

// archive builds a zip from explicit entries, so tests can smuggle hostile names.
func archive(t *testing.T, entries ...archiveEntry) []byte {
	t.Helper()
	require.NotEmpty(t, entries)
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate}
		if entry.mode != 0 {
			header.SetMode(entry.mode)
		}
		part, err := writer.CreateHeader(header)
		require.NoError(t, err)
		_, err = part.Write([]byte(entry.data))
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())
	return buffer.Bytes()
}

// zipTree packages an existing directory, which is how the WASM fixture is fed.
func zipTree(t *testing.T, dir string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	require.NoError(t, filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		relative, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		part, err := writer.Create(filepath.ToSlash(relative))
		if err != nil {
			return err
		}
		_, err = part.Write(data)
		return err
	}))
	require.NoError(t, writer.Close())
	return buffer.Bytes()
}

func readStateDocument(t *testing.T, dataDir string) stateDocument {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dataDir, "extensions", StateFileName))
	require.NoError(t, err)
	var document stateDocument
	require.NoError(t, json.Unmarshal(raw, &document))
	return document
}

// TestBootScansPackagesAndRestoresState proves the catalogue and the enable
// decisions survive a restart without an import call.
func TestBootScansPackagesAndRestoresState(t *testing.T) {
	dataDir := t.TempDir()
	packageDir := filepath.Join(dataDir, "extensions", "com.example.frontend")
	writeFrontendPackage(t, packageDir, "com.example.frontend", "1.0.0")
	writeFile(t, filepath.Join(dataDir, "extensions", StateFileName),
		`{"version":1,"extensions":{"com.example.frontend":{"enabled":false}}}`)

	manager := newTestManager(t, dataDir, nil)
	items, err := manager.List()
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "com.example.frontend", items[0].ID)
	require.False(t, items[0].Enabled)
	require.Equal(t, string(plugins.StateDisabled), items[0].State)
	require.Empty(t, manager.Boot())

	// Enabling through the API must persist for the next boot.
	updated, err := manager.SetEnabled("com.example.frontend", true)
	require.NoError(t, err)
	require.True(t, updated.Enabled)
	require.Equal(t, string(plugins.StateEnabled), updated.State)
	require.NotEmpty(t, updated.EnabledAt)
	require.Len(t, manager.Boot(), 1)

	restarted := newTestManager(t, dataDir, nil)
	defer restarted.Close()
	items, err = restarted.List()
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.True(t, items[0].Enabled)
	require.Len(t, restarted.Boot(), 1)
	require.True(t, readStateDocument(t, dataDir).Extensions["com.example.frontend"].Enabled)
}

// TestBootSkipsBrokenPackagesWithoutFailing proves one bad directory does not
// block startup and stays visible as a failed catalogue entry.
func TestBootSkipsBrokenPackagesWithoutFailing(t *testing.T) {
	dataDir := t.TempDir()
	root := filepath.Join(dataDir, "extensions")
	writeFile(t, filepath.Join(root, "not-a-package", "readme.txt"), "not an extension")
	writeFile(t, filepath.Join(root, "com.example.broken", plugins.ManifestFileName), `{
  "manifest_version": 1,
  "id": "com.example.broken",
  "name": "Broken backend",
  "version": "1.0.0",
  "engines": {"pp": ">=0.1.0 <1.0.0"},
  "runtime": "wasm",
  "backend": {"entry": "backend/broken.wasm", "abi": "wasi-json-v1"},
  "permissions": []
}`)
	writeFile(t, filepath.Join(root, "com.example.broken", "backend", "broken.wasm"), "this is not wasm")

	manager := newTestManager(t, dataDir, nil)
	items, err := manager.List()
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "com.example.broken", items[0].ID)
	require.Equal(t, string(plugins.StateFailed), items[0].State)
	require.NotEmpty(t, items[0].LastError)
	require.Empty(t, manager.Boot())
}

// TestImportFrontendPackage covers the whole happy path of a browser-only zip.
func TestImportFrontendPackage(t *testing.T) {
	dataDir := t.TempDir()
	source := filepath.Join(t.TempDir(), "package")
	writeFrontendPackage(t, source, "com.example.frontend", "1.0.0")

	manager := newTestManager(t, dataDir, nil)
	imported, err := manager.ImportZip(bytes.NewReader(zipTree(t, source)), 0)
	require.NoError(t, err)
	require.Equal(t, "com.example.frontend", imported.ID)
	require.Equal(t, "1.0.0", imported.Version)
	require.Equal(t, "none", imported.Runtime)
	require.True(t, imported.Enabled)
	require.Equal(t, string(plugins.StateEnabled), imported.State)
	require.NotEmpty(t, imported.InstalledAt)
	require.Equal(t, []string{"ui.block", "ui.inject", "ui.style"}, imported.Permissions)
	require.Nil(t, imported.Backend)
	require.NotNil(t, imported.Frontend)
	require.Equal(t, "/plugins/com.example.frontend/1.0.0/client.js", imported.Frontend.Entry)
	require.Equal(t, []string{"client.css"}, imported.Frontend.Styles)
	require.Equal(t, []string{"article.after"}, imported.Frontend.Slots)
	require.Equal(t, []ExtensionBlock{{Type: "frontend.card", Name: "Card"}}, imported.Frontend.Blocks)

	// The package is on disk and the decision is persisted.
	require.FileExists(t, filepath.Join(dataDir, "extensions", "com.example.frontend", plugins.ManifestFileName))
	require.True(t, readStateDocument(t, dataDir).Extensions["com.example.frontend"].Enabled)

	// The runtime boot manifest now contains the extension.
	boot := manager.Boot()
	require.Len(t, boot, 1)
	require.Equal(t, "com.example.frontend", boot[0].ID)
	require.Equal(t, "/plugins/com.example.frontend/1.0.0/client.js", boot[0].Entry)

	items, err := manager.List()
	require.NoError(t, err)
	require.Len(t, items, 1)
}

// TestImportWasmPackage installs the reference Go/WASM fixture and checks the
// backend projection the management page renders.
func TestImportWasmPackage(t *testing.T) {
	dataDir := t.TempDir()
	helloDir := filepath.Join("..", "plugins", "testdata", "hello")
	require.DirExists(t, helloDir)

	manager := newTestManager(t, dataDir, nil)
	imported, err := manager.ImportZip(bytes.NewReader(zipTree(t, helloDir)), 0)
	require.NoError(t, err)
	require.Equal(t, "com.example.hello", imported.ID)
	require.Equal(t, "wasm", imported.Runtime)
	require.True(t, imported.Enabled)
	require.NotNil(t, imported.Backend)
	require.True(t, imported.Backend.Wasm)
	require.Len(t, imported.Backend.Routes, 2)
	require.Equal(t, "GET", imported.Backend.Routes[0].Method)
	require.Equal(t, "/hello", imported.Backend.Routes[0].Path)
	require.Equal(t, "public", imported.Backend.Routes[0].Auth)
	require.Equal(t, "admin", imported.Backend.Routes[1].Auth)
	require.Equal(t, []string{"content.render"}, imported.Backend.Hooks)
	require.Equal(t, 300, imported.Backend.TimeoutMS)
	require.Equal(t, 64, imported.Backend.MaxMemoryMB)
	require.NotNil(t, imported.Frontend)
	require.Equal(t, "/plugins/com.example.hello/1.0.0/client.js", imported.Frontend.Entry)
	require.Len(t, manager.Boot(), 1)
}

// TestImportUpgradeKeepsEnableState proves re-importing one id replaces the
// package while preserving the operator's decision.
func TestImportUpgradeKeepsEnableState(t *testing.T) {
	dataDir := t.TempDir()
	first := filepath.Join(t.TempDir(), "v1")
	writeFrontendPackage(t, first, "com.example.frontend", "1.0.0")
	second := filepath.Join(t.TempDir(), "v2")
	writeFrontendPackage(t, second, "com.example.frontend", "1.0.1")

	manager := newTestManager(t, dataDir, nil)
	_, err := manager.ImportZip(bytes.NewReader(zipTree(t, first)), 0)
	require.NoError(t, err)
	_, err = manager.SetEnabled("com.example.frontend", false)
	require.NoError(t, err)

	upgraded, err := manager.ImportZip(bytes.NewReader(zipTree(t, second)), 0)
	require.NoError(t, err)
	require.Equal(t, "1.0.1", upgraded.Version)
	require.False(t, upgraded.Enabled, "an upgrade must keep the disabled decision")

	// Re-enable and re-import again: the enabled decision is kept too.
	_, err = manager.SetEnabled("com.example.frontend", true)
	require.NoError(t, err)
	reinstalled, err := manager.ImportZip(bytes.NewReader(zipTree(t, second)), 0)
	require.NoError(t, err)
	require.True(t, reinstalled.Enabled)

	items, err := manager.List()
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "1.0.1", items[0].Version)
}

// TestImportAcceptsWindowsZipSeparators keeps Windows-built packages installable.
// PowerShell's Compress-Archive writes "frontend\client.js"; the zip spec says
// "/". The manager normalises separators, then applies the usual safety checks.
func TestImportAcceptsWindowsZipSeparators(t *testing.T) {
	dataDir := t.TempDir()
	manager := newTestManager(t, dataDir, nil)
	payload := archive(t,
		archiveEntry{name: plugins.ManifestFileName, data: frontendManifest("com.example.windows", "1.0.0")},
		archiveEntry{name: `frontend\client.js`, data: "window.__PP_PLUGIN_REGISTER__()"},
		archiveEntry{name: `frontend\client.css`, data: ".windows-card{color:red}"},
	)
	extension, err := manager.ImportZip(bytes.NewReader(payload), 0)
	require.NoError(t, err)
	require.Equal(t, "com.example.windows", extension.ID)
	require.True(t, extension.Enabled)
	require.FileExists(t, filepath.Join(dataDir, "extensions", "com.example.windows", "frontend", "client.js"))
	require.FileExists(t, filepath.Join(dataDir, "extensions", "com.example.windows", "frontend", "client.css"))
}

// TestRemoveUsesTheAdoptedDirectory is the regression test for a package whose
// directory name differs from its manifest id: removal must delete the directory
// that was actually loaded, otherwise the next boot re-adopts it.
func TestRemoveUsesTheAdoptedDirectory(t *testing.T) {
	dataDir := t.TempDir()
	packageDir := filepath.Join(dataDir, "extensions", "acme-press")
	writeFrontendPackage(t, packageDir, "com.example.acme", "1.0.0")

	manager := newTestManager(t, dataDir, nil)
	items, err := manager.List()
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "com.example.acme", items[0].ID)

	require.NoError(t, manager.Remove("com.example.acme"))
	require.NoDirExists(t, packageDir)

	// A restart must not find the package again.
	restarted := newTestManager(t, dataDir, nil)
	items, err = restarted.List()
	require.NoError(t, err)
	require.Empty(t, items)
}

// TestRemoveExtension deletes the package and its state entry.
func TestRemoveExtension(t *testing.T) {
	dataDir := t.TempDir()
	source := filepath.Join(t.TempDir(), "package")
	writeFrontendPackage(t, source, "com.example.frontend", "1.0.0")

	manager := newTestManager(t, dataDir, nil)
	_, err := manager.ImportZip(bytes.NewReader(zipTree(t, source)), 0)
	require.NoError(t, err)
	require.NoError(t, manager.Remove("com.example.frontend"))

	items, err := manager.List()
	require.NoError(t, err)
	require.Empty(t, items)
	require.Empty(t, manager.Boot())
	require.NoDirExists(t, filepath.Join(dataDir, "extensions", "com.example.frontend"))
	require.Empty(t, readStateDocument(t, dataDir).Extensions)

	require.ErrorIs(t, manager.Remove("com.example.frontend"), ErrExtensionNotFound)
	_, err = manager.SetEnabled("com.example.frontend", true)
	require.ErrorIs(t, err, ErrExtensionNotFound)

	// A crafted path parameter must never resolve outside the package root.
	require.ErrorIs(t, manager.Remove(".."), ErrExtensionNotFound)
	require.ErrorIs(t, manager.Remove("../state"), ErrExtensionNotFound)
	require.DirExists(t, filepath.Dir(filepath.Join(dataDir, "extensions")))
}

// TestImportRejectsUnsafeArchive covers the zip security rules.
func TestImportRejectsUnsafeArchive(t *testing.T) {
	validManifest := archiveEntry{name: plugins.ManifestFileName, data: frontendManifest("com.example.frontend", "1.0.0")}
	cases := map[string]archiveEntry{
		"traversal":           {name: "../escape.txt", data: "x"},
		"nested traversal":    {name: "frontend/../../escape.txt", data: "x"},
		"backslash traversal": {name: `frontend\..\..\escape.txt`, data: "x"},
		"backslash absolute":  {name: `\escape.txt`, data: "x"},
		"absolute":            {name: "/escape.txt", data: "x"},
		"windows drive":       {name: "C:/escape.txt", data: "x"},
		"reserved name":       {name: "CON", data: "x"},
		"reserved extension":  {name: "aux.txt", data: "x"},
		"trailing dot":        {name: "frontend/client.js.", data: "x"},
		"alternate data":      {name: "frontend/client.js:hidden", data: "x"},
		"empty segment":       {name: "frontend//client.js", data: "x"},
	}
	for name, hostile := range cases {
		t.Run(name, func(t *testing.T) {
			dataDir := t.TempDir()
			manager := newTestManager(t, dataDir, nil)
			payload := archive(t, hostile, validManifest)
			_, err := manager.ImportZip(bytes.NewReader(payload), 0)
			require.ErrorIs(t, err, ErrInvalidPackage)
			require.NoDirExists(t, filepath.Join(dataDir, "extensions", "com.example.frontend"))
			// Nothing escaped into the data directory's parent.
			require.NoFileExists(t, filepath.Join(dataDir, "escape.txt"))
		})
	}

	t.Run("symlink", func(t *testing.T) {
		dataDir := t.TempDir()
		manager := newTestManager(t, dataDir, nil)
		payload := archive(t, archiveEntry{
			name: "frontend/link.js",
			data: "/etc/passwd",
			mode: os.ModeSymlink | 0o777,
		}, validManifest)
		_, err := manager.ImportZip(bytes.NewReader(payload), 0)
		require.ErrorIs(t, err, ErrInvalidPackage)
	})

	t.Run("missing manifest", func(t *testing.T) {
		dataDir := t.TempDir()
		manager := newTestManager(t, dataDir, nil)
		payload := archive(t, archiveEntry{name: "frontend/client.js", data: "x"})
		_, err := manager.ImportZip(bytes.NewReader(payload), 0)
		require.ErrorIs(t, err, ErrInvalidPackage)
	})

	t.Run("invalid manifest", func(t *testing.T) {
		dataDir := t.TempDir()
		manager := newTestManager(t, dataDir, nil)
		payload := archive(t, archiveEntry{name: plugins.ManifestFileName, data: "{}"})
		_, err := manager.ImportZip(bytes.NewReader(payload), 0)
		require.ErrorIs(t, err, ErrInvalidPackage)
	})

	t.Run("not a zip", func(t *testing.T) {
		dataDir := t.TempDir()
		manager := newTestManager(t, dataDir, nil)
		_, err := manager.ImportZip(strings.NewReader("definitely not a zip"), 0)
		require.ErrorIs(t, err, ErrInvalidPackage)
	})
}

// TestExtensionJSONShape freezes the snake_case DTO field names the extension
// management page consumes. Changing a key here is a frontend breaking change.
func TestExtensionJSONShape(t *testing.T) {
	extension := Extension{
		ID:          "com.example.frontend",
		Name:        "Frontend",
		Version:     "1.0.0",
		Description: "A browser-only extension.",
		Author:      "Practacu Press",
		License:     "MIT",
		Homepage:    "https://example.com",
		State:       "enabled",
		Enabled:     true,
		Runtime:     "none",
		Permissions: []string{"ui.inject"},
		Frontend: &ExtensionFrontend{
			Entry:  "/plugins/com.example.frontend/1.0.0/client.js",
			Styles: []string{"client.css"},
			Slots:  []string{"article.after"},
			Blocks: []ExtensionBlock{{Type: "frontend.card", Name: "Card"}},
		},
		InstalledAt: "2026-01-02T03:04:05Z",
		EnabledAt:   "2026-01-02T03:04:06Z",
	}
	raw, err := json.Marshal(extension)
	require.NoError(t, err)
	require.JSONEq(t, `{
  "id": "com.example.frontend",
  "name": "Frontend",
  "version": "1.0.0",
  "description": "A browser-only extension.",
  "author": "Practacu Press",
  "license": "MIT",
  "homepage": "https://example.com",
  "state": "enabled",
  "enabled": true,
  "runtime": "none",
  "permissions": ["ui.inject"],
  "frontend": {
    "entry": "/plugins/com.example.frontend/1.0.0/client.js",
    "styles": ["client.css"],
    "slots": ["article.after"],
    "blocks": [{"type": "frontend.card", "name": "Card"}]
  },
  "backend": null,
  "installed_at": "2026-01-02T03:04:05Z",
  "enabled_at": "2026-01-02T03:04:06Z"
}`, string(raw))

	backend := Extension{
		ID:          "com.example.hello",
		Name:        "Hello",
		Version:     "1.0.0",
		Description: "",
		State:       "disabled",
		Runtime:     "wasm",
		Permissions: []string{"content.render"},
		Backend: &ExtensionBackend{
			Wasm:        true,
			Routes:      []ExtensionRoute{{Method: "GET", Path: "/hello", Auth: "public"}},
			Hooks:       []string{"content.render"},
			TimeoutMS:   300,
			MaxMemoryMB: 64,
		},
	}
	raw, err = json.Marshal(backend)
	require.NoError(t, err)
	require.Contains(t, string(raw), `"frontend":null`)
	require.Contains(t, string(raw), `"backend":{"wasm":true,"routes":[{"method":"GET","path":"/hello","auth":"public"}],"hooks":["content.render"],"timeout_ms":300,"max_memory_mb":64}`)
}

// TestImportEnforcesLimits checks the size, unpacked and file-count bounds.
func TestImportEnforcesLimits(t *testing.T) {
	t.Run("upload ceiling", func(t *testing.T) {
		dataDir := t.TempDir()
		source := filepath.Join(t.TempDir(), "package")
		writeFrontendPackage(t, source, "com.example.frontend", "1.0.0")
		manager := newTestManager(t, dataDir, nil)
		_, err := manager.ImportZip(bytes.NewReader(zipTree(t, source)), 16)
		require.ErrorIs(t, err, ErrPackageTooLarge)
	})

	t.Run("unpacked ceiling", func(t *testing.T) {
		dataDir := t.TempDir()
		source := filepath.Join(t.TempDir(), "package")
		writeFrontendPackage(t, source, "com.example.frontend", "1.0.0")
		manager := newTestManager(t, dataDir, func(options *Options) {
			options.MaxUnpackedBytes = 32
		})
		_, err := manager.ImportZip(bytes.NewReader(zipTree(t, source)), 0)
		require.ErrorIs(t, err, ErrPackageTooLarge)
	})

	t.Run("file count ceiling", func(t *testing.T) {
		dataDir := t.TempDir()
		source := filepath.Join(t.TempDir(), "package")
		writeFrontendPackage(t, source, "com.example.frontend", "1.0.0")
		manager := newTestManager(t, dataDir, func(options *Options) {
			options.MaxFiles = 2
		})
		_, err := manager.ImportZip(bytes.NewReader(zipTree(t, source)), 0)
		require.ErrorIs(t, err, ErrInvalidPackage)
	})
}
