package plugins

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func validManifest() Manifest {
	return Manifest{
		ManifestVersion: 1,
		ID:              "com.example.demo",
		Name:            "Demo",
		Version:         "1.2.3",
		Engines:         Engines{PP: ">=0.1.0 <1.0.0", Contract: ">=1.0.0 <2.0.0"},
		Runtime:         "wasm",
		Backend: &Backend{
			Entry: "backend/demo.wasm",
			ABI:   "wasi-json-v1",
			Hooks: []string{"content.render"},
			Routes: []Route{{
				Method:   "GET",
				Path:     "/hello",
				Auth:     "public",
				Contract: json.RawMessage(`{"summary":"hi","responses":{"200":{"description":"ok"}}}`),
			}},
		},
		Permissions: []string{"content.render", "http.route.public"},
	}
}

func TestValidateManifestAcceptsTheReferenceShape(t *testing.T) {
	manifest := validManifest()
	require.NoError(t, ValidateManifest(manifest, ""))
}

func TestValidateManifestRejectsUnknownFields(t *testing.T) {
	dir := t.TempDir()
	raw := `{
		"manifest_version": 1,
		"id": "com.example.demo",
		"name": "Demo",
		"version": "1.0.0",
		"engines": {"pp": ">=0.1.0"},
		"runtime": "none",
		"unexpected": true
	}`
	require.NoError(t, os.WriteFile(filepath.Join(dir, ManifestFileName), []byte(raw), 0o600))
	_, err := LoadManifest(dir)
	require.Error(t, err)
	require.Contains(t, err.Error(), "unknown field")
}

func TestValidateManifestRejectsCapabilityEscalation(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Manifest)
		want   string
	}{
		{
			name: "public route without permission",
			mutate: func(m *Manifest) {
				m.Permissions = []string{"content.render"}
			},
			want: "http.route.public",
		},
		{
			name: "hook without permission",
			mutate: func(m *Manifest) {
				m.Permissions = []string{"http.route.public"}
			},
			want: "content.render",
		},
		{
			name: "admin route without permission",
			mutate: func(m *Manifest) {
				m.Backend.Routes[0].Auth = "admin"
			},
			want: "admin.route",
		},
		{
			name: "script src escape",
			mutate: func(m *Manifest) {
				m.Backend.Entry = "../escape.wasm"
			},
			want: "escapes",
		},
		{
			name: "unsupported abi",
			mutate: func(m *Manifest) {
				m.Backend.ABI = "native-v1"
			},
			want: "abi",
		},
		{
			name: "route without contract",
			mutate: func(m *Manifest) {
				m.Backend.Routes[0].Contract = nil
			},
			want: "contract",
		},
		{
			name: "contract ref",
			mutate: func(m *Manifest) {
				m.Backend.Routes[0].Contract = json.RawMessage(`{"responses":{"200":{"description":"ok"}},"requestBody":{"$ref":"#/components/schemas/X"}}`)
			},
			want: "$ref",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			manifest := validManifest()
			test.mutate(&manifest)
			err := ValidateManifest(manifest, "")
			require.Error(t, err)
			require.Contains(t, err.Error(), test.want)
		})
	}
}

func TestValidateManifestRejectsFrontendWithoutPermission(t *testing.T) {
	manifest := validManifest()
	manifest.Backend = nil
	manifest.Runtime = "none"
	manifest.Permissions = []string{"http.route.public"}
	manifest.Frontend = &Frontend{Entry: "frontend/client.js"}
	err := ValidateManifest(manifest, "")
	require.Error(t, err)
	require.Contains(t, err.Error(), "ui.inject")
}

// TestValidateManifestAcceptsThemeBlockMetadata pins the contract the page
// builder relies on: a theme component declares how it is presented (name,
// variants, area) and how a fresh block starts (defaults, schema).
func TestValidateManifestAcceptsThemeBlockMetadata(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "frontend"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "frontend", "client.js"), []byte("// bundle"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "frontend", "client.css"), []byte("/* base */"), 0o600))

	manifest := Manifest{
		ManifestVersion: 1,
		ID:              "com.example.theme",
		Name:            "Theme",
		Version:         "1.0.0",
		Engines:         Engines{PP: ">=0.1.0 <1.0.0"},
		Runtime:         "none",
		Frontend: &Frontend{
			Entry:  "frontend/client.js",
			Styles: []string{"frontend/client.css"},
			Blocks: []BlockSpec{{
				Type:        "aurora.hero",
				Name:        "极光开屏",
				Description: "大标题与两个按钮。",
				Group:       "shared",
				Variants:    []string{"classic", "bento"},
				Area:        "full",
				Defaults:    json.RawMessage(`{"heading":"Aurora","sub":"文字"}`),
				Schema: json.RawMessage(`[
					{"key":"heading","label":"主标题","type":"text"},
					{"key":"sub","label":"副标题","type":"textarea"}
				]`),
			}},
		},
		Permissions: []string{"ui.inject", "ui.block", "ui.style"},
	}
	require.NoError(t, ValidateManifest(manifest, dir))
}

func TestValidateManifestRejectsBadThemeBlockMetadata(t *testing.T) {
	base := func() Manifest {
		return Manifest{
			ManifestVersion: 1,
			ID:              "com.example.theme",
			Name:            "Theme",
			Version:         "1.0.0",
			Engines:         Engines{PP: ">=0.1.0 <1.0.0"},
			Runtime:         "none",
			Frontend: &Frontend{
				Entry:  "frontend/client.js",
				Blocks: []BlockSpec{{Type: "aurora.hero"}},
			},
			Permissions: []string{"ui.inject", "ui.block"},
		}
	}
	cases := []struct {
		name   string
		mutate func(*BlockSpec)
		want   string
	}{
		{"bad type", func(b *BlockSpec) { b.Type = "Aurora Hero" }, "lowercase kebab"},
		{"unknown variant", func(b *BlockSpec) { b.Variants = []string{"magazine"} }, "variant"},
		{"unknown area", func(b *BlockSpec) { b.Area = "header" }, "area"},
		{"defaults not object", func(b *BlockSpec) { b.Defaults = json.RawMessage(`["x"]`) }, "JSON object"},
		{"nested default", func(b *BlockSpec) {
			b.Defaults = json.RawMessage(`{"heading":{"x":1}}`)
		}, "scalar"},
		{"schema not array", func(b *BlockSpec) { b.Schema = json.RawMessage(`{"key":"x"}`) }, "JSON array"},
		{"schema missing type", func(b *BlockSpec) {
			b.Schema = json.RawMessage(`[{"key":"heading","label":"标题"}]`)
		}, "key and type"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			manifest := base()
			test.mutate(&manifest.Frontend.Blocks[0])
			err := ValidateManifest(manifest, "")
			require.Error(t, err)
			require.Contains(t, err.Error(), test.want)
		})
	}
}

func TestSatisfiesSupportsTheDocumentedGrammar(t *testing.T) {
	cases := []struct {
		version string
		rng     string
		want    bool
	}{
		{"0.1.0", ">=0.1.0 <1.0.0", true},
		{"1.0.0", ">=0.1.0 <1.0.0", false},
		{"1.4.2", "^1.2.0", true},
		{"2.0.0", "^1.2.0", false},
		{"1.4.2", "~1.4.0", true},
		{"1.5.0", "~1.4.0", false},
		{"1.2.3", "1.2.3", true},
		{"1.2.4", "1.2.3", false},
	}
	for _, test := range cases {
		require.Equal(t, test.want, Satisfies(test.version, test.rng), "%s in %s", test.version, test.rng)
	}
}
