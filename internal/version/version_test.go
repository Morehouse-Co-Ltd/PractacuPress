package version_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/version"
)

// The root VERSION file is the only hand-edited product version. This test
// fails as soon as a generated or checked-in declaration drifts from it, which
// is what keeps the frontend, npm metadata and backend on one number.
func TestVersionFilesAgree(t *testing.T) {
	root := filepath.Join("..", "..")

	raw, err := os.ReadFile(filepath.Join(root, "VERSION"))
	require.NoError(t, err)
	require.Equal(t, version.Version, strings.TrimSpace(string(raw)))

	require.Regexp(t, regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-beta[0-9]*)?$`), version.Version)

	var manifest struct {
		Version string `json:"version"`
		Style   string `json:"style"`
	}
	raw, err = os.ReadFile(filepath.Join(root, "web", "public", "version.json"))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &manifest))
	require.Equal(t, version.Version, manifest.Version)
	require.Equal(t, channel(), manifest.Style)

	var webPackage struct {
		Version string `json:"version"`
	}
	raw, err = os.ReadFile(filepath.Join(root, "web", "package.json"))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &webPackage))
	require.Equal(t, version.Version, webPackage.Version)

	var lock struct {
		Version  string `json:"version"`
		Packages map[string]struct {
			Version string `json:"version"`
		} `json:"packages"`
	}
	raw, err = os.ReadFile(filepath.Join(root, "web", "package-lock.json"))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &lock))
	require.Equal(t, version.Version, lock.Version)
	require.Equal(t, version.Version, lock.Packages[""].Version)
}

func channel() string {
	if strings.Contains(version.Version, "-beta") {
		return "beta"
	}
	return "stable"
}
