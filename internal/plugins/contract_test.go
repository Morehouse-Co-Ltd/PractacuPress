package plugins

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/version"
)

// The plugin-aware endpoint serves this composed document instead of
// openapi.JSON directly, so it must also carry the binary's version.
func TestComposeContractUsesProductVersion(t *testing.T) {
	document, err := composeContract(nil, nil)
	require.NoError(t, err)

	info, ok := document["info"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, version.Version, info["version"])
}
