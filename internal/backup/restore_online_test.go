package backup

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/site"
)

// TestRestoreStoredOnlineSQLite exercises the full page-driven path: the target
// database stays open, a verified safety backup is created first, and the live
// handle is restored from the package.
func TestRestoreStoredOnlineSQLite(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dbPath := filepath.Join(root, "practacu.db")
	mediaDir := filepath.Join(root, "media")
	backupDir := filepath.Join(root, "backups")
	require.NoError(t, os.MkdirAll(filepath.Join(mediaDir, "ab"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(mediaDir, "ab", "image.png"), []byte("png-bytes"), 0o644))

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(dbPath))
	require.NoError(t, err)
	require.NoError(t, handle.Client.Schema.Create(ctx))
	defer handle.Close()

	siteRow, err := handle.Client.Site.Create().
		SetSlug("alpha").
		SetName("Alpha").
		SetDomain("alpha.example").
		Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.SiteCustomization.Create().
		SetSiteID(siteRow.ID).
		SetDocument(`{"pages":[{"id":"p1","title":"About"}]}`).
		SetRevision(1).
		Save(ctx)
	require.NoError(t, err)

	service, err := NewService(Config{
		Driver:        "sqlite",
		DSN:           db.SQLiteDSN(dbPath),
		Snapshotter:   handle,
		Online:        handle,
		MediaRoots:    []MediaRoot{{Alias: "global", Driver: "local", Dir: mediaDir}},
		Designs:       NewDBDesignSource(handle),
		BackupDir:     backupDir,
		SchemaVersion: db.SchemaVersion,
		AppVersion:    "test",
		Now:           func() time.Time { return time.Date(2026, 11, 7, 4, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)

	artifact, err := service.CreateBackup(ctx)
	require.NoError(t, err)
	_, err = handle.Client.Site.Create().
		SetSlug("beta").
		SetName("Beta").
		SetDomain("beta.example").
		Save(ctx)
	require.NoError(t, err)
	before, err := handle.Inspect(ctx)
	require.NoError(t, err)
	require.Equal(t, 2, before.Sites)

	result, err := service.RestoreStored(ctx, artifact.ID, Actor{
		UserID: "admin-1",
		SiteID: "site-1",
		Role:   site.RolePlatformAdmin,
	}, "req_restore")
	require.NoError(t, err)
	require.Equal(t, 1, result.Sites)
	require.Equal(t, 1, result.MediaFiles)
	require.NotEmpty(t, result.SafetyBackupID)
	require.NotEqual(t, artifact.ID, result.SafetyBackupID)
	require.FileExists(t, filepath.Join(backupDir, result.SafetyBackupID+".meta.json"))

	after, err := handle.Inspect(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, after.Sites)
	require.NoError(t, handle.VerifySchema(ctx))

	backups, err := service.ListBackups(ctx, Actor{Role: site.RolePlatformAdmin})
	require.NoError(t, err)
	require.Len(t, backups, 2)

	// A site administrator cannot restore even when they hold every site-level
	// capability.
	_, err = service.RestoreStored(ctx, artifact.ID, Actor{
		UserID: "site-admin",
		SiteID: "site-1",
		Role:   site.RoleSiteAdmin,
	}, "")
	require.ErrorIs(t, err, ErrPermissionDenied)

	// Missing packages are reported before a safety backup is created.
	_, err = service.RestoreStored(ctx, "backup-20200101-000000", Actor{
		UserID: "admin-1",
		SiteID: "site-1",
		Role:   site.RolePlatformAdmin,
	}, "")
	require.ErrorIs(t, err, ErrNotFound)

	// A service without a live handle refuses the page path.
	unsupported, err := NewService(Config{
		Driver:    "sqlite",
		DSN:       db.SQLiteDSN(dbPath),
		BackupDir: backupDir,
		Now:       func() time.Time { return time.Date(2026, 11, 7, 4, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)
	_, err = unsupported.RestoreStored(ctx, artifact.ID, Actor{Role: site.RolePlatformAdmin}, "")
	require.ErrorIs(t, err, ErrRestoreUnsupported)
}
