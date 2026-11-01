package db_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
)

// TestEnsureSQLitePragmasAddsRuntimeDefaults covers the path a real deployment takes:
// the DSN comes from DATABASE_DSN, so these pragmas decide how the server's database
// behaves. WAL keeps readers from blocking the single writer; busy_timeout makes a
// competing writer wait instead of failing with "database is locked".
func TestEnsureSQLitePragmasAddsRuntimeDefaults(t *testing.T) {
	for name, dsn := range map[string]string{
		"plain":    "file:./data/practacu.db",
		"with args": "file:./data/practacu.db?cache=shared",
	} {
		augmented := db.EnsureSQLitePragmas(dsn)
		require.Contains(t, augmented, "foreign_keys", name)
		require.Contains(t, augmented, "journal_mode", name)
		require.Contains(t, augmented, "busy_timeout", name)
	}

	// An operator supplied pragma is a deliberate choice and stays untouched.
	explicit := "file:x.db?_pragma=foreign_keys(0)"
	require.Equal(t, explicit, db.EnsureSQLitePragmas(explicit))
}

// TestOpenSQLiteEnablesWriteAheadLogging is the end to end proof: the pragma is not just
// present in the DSN string, it actually switched the database into WAL mode.
func TestOpenSQLiteEnablesWriteAheadLogging(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "wal.db")

	handle, err := db.Open(ctx, "sqlite", db.EnsureSQLitePragmas("file:"+path))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })

	require.NoError(t, handle.Client.Schema.Create(ctx))
	_, err = handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	// A rollback-journal database never creates the -wal file.
	require.FileExists(t, path+"-wal",
		"journal_mode=WAL must be active on the connection the server actually uses")
}
