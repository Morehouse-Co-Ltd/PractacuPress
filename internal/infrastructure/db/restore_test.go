package db

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestRestoreFromCopiesSnapshotIntoLiveDatabase guards the trickiest part of the
// in-process restore: the database file must not be renamed while the process has
// it open. The live connection is overwritten through SQLite's online backup API.
func TestRestoreFromCopiesSnapshotIntoLiveDatabase(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dbPath := filepath.Join(root, "live.db")
	snapshotPath := filepath.Join(root, "snapshot.db")

	handle, err := Open(ctx, "sqlite", SQLiteDSN(dbPath))
	require.NoError(t, err)
	defer handle.Close()
	require.NoError(t, handle.Client.Schema.Create(ctx))

	_, err = handle.Client.Site.Create().
		SetSlug("alpha").
		SetName("Alpha").
		SetDomain("alpha.example").
		Save(ctx)
	require.NoError(t, err)
	require.NoError(t, handle.Snapshot(ctx, snapshotPath))

	_, err = handle.Client.Site.Create().
		SetSlug("beta").
		SetName("Beta").
		SetDomain("beta.example").
		Save(ctx)
	require.NoError(t, err)
	before, err := handle.Inspect(ctx)
	require.NoError(t, err)
	require.Equal(t, 2, before.Sites)

	require.NoError(t, handle.RestoreFrom(ctx, snapshotPath))
	after, err := handle.Inspect(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, after.Sites)
	require.NoError(t, handle.VerifySchema(ctx))

	// A larger pool means another request could read or write the old pages while
	// the backup API is copying. Refuse instead of pretending the restore is safe.
	handle.ConfigurePool(2, 0, 0)
	err = handle.RestoreFrom(ctx, snapshotPath)
	require.ErrorIs(t, err, ErrRestoreUnsupported)
}
