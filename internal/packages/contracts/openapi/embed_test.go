package openapi_test

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"github.com/practacu/practacu-press/internal/packages/contracts/openapi"
	"github.com/practacu/practacu-press/internal/version"
)

// TestJSONMatchesTheEmbeddedContract keeps the runtime document and the checked-in
// YAML in step: the server answers /api/v1/openapi.json from this JSON, so a path
// the YAML promises must be present here too.
func TestJSONMatchesTheEmbeddedContract(t *testing.T) {
	raw, err := openapi.JSON()
	require.NoError(t, err)
	require.NotEmpty(t, raw)

	var spec struct {
		OpenAPI string `json:"openapi"`
		Info    struct {
			Title   string `json:"title"`
			Version string `json:"version"`
		} `json:"info"`
		Servers []struct {
			URL string `json:"url"`
		} `json:"servers"`
		Paths map[string]map[string]any `json:"paths"`
	}
	require.NoError(t, json.Unmarshal(raw, &spec))

	require.Equal(t, "3.1.0", spec.OpenAPI)
	require.NotEmpty(t, spec.Info.Title)
	require.Equal(t, version.Version, spec.Info.Version)
	require.NotEmpty(t, spec.Servers)
	require.Equal(t, "/api/v1", spec.Servers[0].URL)

	// The contract is the product's real API surface; a regression that empties it is
	// exactly what the old placeholder handler shipped.
	require.GreaterOrEqual(t, len(spec.Paths), 50)
	require.Contains(t, spec.Paths, "/articles")
	require.Contains(t, spec.Paths, "/sites/{siteID}/settings")
	require.NotEmpty(t, spec.Paths["/articles"]["get"])
}

// TestYAMLInfoVersionMatchesVersion keeps the checked-in YAML aligned even
// though JSON() patches the value at runtime for release builds.
func TestYAMLInfoVersionMatchesVersion(t *testing.T) {
	var spec struct {
		Info struct {
			Version string `yaml:"version"`
		} `yaml:"info"`
	}
	require.NoError(t, yaml.Unmarshal(openapi.YAML(), &spec))
	require.Equal(t, version.Version, spec.Info.Version)
}

// TestYAMLReturnsACopy protects the shared embedded bytes from callers that write
// into the slice they receive.
func TestYAMLReturnsACopy(t *testing.T) {
	first := openapi.YAML()
	require.NotEmpty(t, first)
	first[0] = 'X'

	second := openapi.YAML()
	require.Equal(t, byte('o'), second[0])
}
