package backup

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMediaRootListPrefersProvider(t *testing.T) {
	calls := 0
	service := &Service{
		mediaRoots: []MediaRoot{{Alias: "static", Driver: "local", Dir: "/static"}},
		mediaRootsProvider: func() []MediaRoot {
			calls++
			return []MediaRoot{{Alias: "dynamic", Driver: "local", Dir: "/dynamic"}}
		},
	}
	roots := service.mediaRootList()
	require.Equal(t, 1, calls)
	require.Equal(t, "dynamic", roots[0].Alias)
}
