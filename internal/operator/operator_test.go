package operator

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestCommandsAreStable pins the dispatch table: every documented subcommand must
// stay reachable from the single binary, and the list must stay sorted for help.
func TestCommandsAreStable(t *testing.T) {
	want := []string{"backup", "media-gc", "migrate", "searchindex", "seed"}
	require.Equal(t, want, Commands())

	for _, name := range want {
		require.True(t, Known(name), name)
	}
}

// TestRunRejectsUnknownCommand keeps a typo from silently starting the HTTP server.
func TestRunRejectsUnknownCommand(t *testing.T) {
	err := Run("serve", nil)
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), `unknown command "serve"`))
}

// TestUsageListsEveryCommand keeps help output and the dispatch table from drifting.
func TestUsageListsEveryCommand(t *testing.T) {
	var out strings.Builder
	Usage(&out)
	for _, name := range Commands() {
		require.Contains(t, out.String(), name)
	}
}
