package db

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSQLiteFileTargetForms(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.db")

	for name, dsn := range map[string]string{
		"bare":        path,
		"file prefix": "file:" + filepath.ToSlash(path),
		"with pragma": SQLiteDSN(path),
	} {
		target, create, err := sqliteFileTarget(dsn)
		require.NoError(t, err, name)
		require.True(t, create, name)
		require.Equal(t, path, target, name)
	}

	for name, dsn := range map[string]string{
		"memory":      ":memory:",
		"file memory": "file::memory:?cache=shared",
		"read only":   "file:" + filepath.ToSlash(path) + "?mode=ro",
		"immutable":   "file:" + filepath.ToSlash(path) + "?immutable=1",
	} {
		_, create, err := sqliteFileTarget(dsn)
		require.NoError(t, err, name)
		require.False(t, create, name, "these DSNs must not be replaced with an empty file")
	}
}

func TestSQLiteFileTargetAcceptsFileURI(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the leading-slash form is specific to Windows drive-letter URIs")
	}
	path := filepath.Join(t.TempDir(), "uri.db")

	target, create, err := sqliteFileTarget("file:///" + filepath.ToSlash(path))
	require.NoError(t, err)
	require.True(t, create)
	require.Equal(t, path, target)
}
