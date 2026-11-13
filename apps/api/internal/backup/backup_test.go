package backup

import (
	"archive/zip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
)

func TestSQLitePathFromDSN(t *testing.T) {
	cases := []struct {
		dsn      string
		expected string
		wantErr  bool
	}{
		{dsn: "file:./data/practacu.db?_pragma=foreign_keys(1)", expected: filepath.FromSlash("./data/practacu.db")},
		{dsn: "file:C:/Users/Some%20One/data.db", expected: filepath.FromSlash("C:/Users/Some One/data.db")},
		{dsn: "./data/practacu.db", expected: filepath.FromSlash("./data/practacu.db")},
		{dsn: ":memory:", wantErr: true},
		{dsn: "file::memory:?cache=shared", wantErr: true},
		{dsn: "", wantErr: true},
	}
	for _, testCase := range cases {
		got, err := SQLitePathFromDSN(testCase.dsn)
		if testCase.wantErr {
			require.Error(t, err, testCase.dsn)
			continue
		}
		require.NoError(t, err, testCase.dsn)
		require.Equal(t, testCase.expected, got, testCase.dsn)
	}
}

func TestBackupCreateVerifyAndRestore(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dbPath := filepath.Join(root, "practacu.db")
	mediaDir := filepath.Join(root, "media")
	backupDir := filepath.Join(root, "backups")
	require.NoError(t, os.MkdirAll(filepath.Join(mediaDir, "ab"), 0o755))
	mediaFile := filepath.Join(mediaDir, "ab", "image.png")
	require.NoError(t, os.WriteFile(mediaFile, []byte("png-bytes"), 0o644))

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
	require.FileExists(t, artifact.Path)
	require.True(t, artifact.IncludesMedia)

	manifest, err := service.VerifyBackup(artifact.Path)
	require.NoError(t, err)
	require.Equal(t, FormatBackup, manifest.Format)
	require.Equal(t, db.SchemaVersion, manifest.SchemaVersion)
	require.Equal(t, "database/practacu.db", manifest.Database.Dump)
	require.Len(t, manifest.Designs, 1)
	require.NotEmpty(t, manifest.Entries)

	reader, err := zip.OpenReader(artifact.Path)
	require.NoError(t, err)
	defer reader.Close()
	names := map[string]bool{}
	for _, file := range reader.File {
		names[file.Name] = true
	}
	require.True(t, names["database/practacu.db"])
	require.True(t, names["design/"+siteRow.ID+".json"])
	require.True(t, names["media/global/ab/image.png"])
	require.True(t, names[ManifestName])

	// Restoring over a non-empty database without confirmation must refuse.
	_, err = service.Restore(ctx, RestoreOptions{
		ArchivePath:  artifact.Path,
		TargetDBPath: dbPath,
		MediaRoots:   []MediaRoot{{Alias: "global", Driver: "local", Dir: mediaDir}},
	})
	require.ErrorIs(t, err, ErrConfirmationRequired)

	// A new empty target needs no confirmation.
	newDBPath := filepath.Join(root, "restored.db")
	result, err := service.Restore(ctx, RestoreOptions{
		ArchivePath:  artifact.Path,
		TargetDBPath: newDBPath,
		MediaRoots:   []MediaRoot{{Alias: "global", Driver: "local", Dir: mediaDir}},
	})
	require.NoError(t, err)
	require.Equal(t, 1, result.Sites)
	require.Equal(t, 1, result.MediaFiles)
	require.Equal(t, db.SchemaVersion, result.SchemaVersion)

	restored, err := db.Open(ctx, "sqlite", db.SQLiteDSN(newDBPath))
	require.NoError(t, err)
	stats, err := restored.Inspect(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, stats.Sites)
	require.NoError(t, restored.VerifySchema(ctx))
	require.NoError(t, restored.Close())

	// Re-importing over the same target now needs a safety backup id.
	_, err = service.Restore(ctx, RestoreOptions{
		ArchivePath:  artifact.Path,
		TargetDBPath: newDBPath,
		MediaRoots:   []MediaRoot{{Alias: "global", Driver: "local", Dir: mediaDir}},
		Confirm:      true,
	})
	require.ErrorIs(t, err, ErrInvalidInput)

	safety, err := service.CreateBackup(ctx)
	require.NoError(t, err)
	result, err = service.Restore(ctx, RestoreOptions{
		ArchivePath:    artifact.Path,
		TargetDBPath:   newDBPath,
		MediaRoots:     []MediaRoot{{Alias: "global", Driver: "local", Dir: mediaDir}},
		Confirm:        true,
		SafetyBackupID: safety.ID,
	})
	require.NoError(t, err)
	require.Equal(t, 1, result.Sites)
}

func TestVerifyDetectsChecksumMismatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tampered.zip")
	file, err := os.Create(path)
	require.NoError(t, err)
	writer := zip.NewWriter(file)
	manifest := BackupManifest{
		Format:        FormatBackup,
		FormatVersion: FormatVersion,
		Kind:          "backup",
		CreatedAt:     time.Now().UTC(),
		Database:      DatabaseInfo{Dump: "database/practacu.db"},
		Entries: []Entry{
			{Path: "a.txt", Size: 1, SHA256: strings.Repeat("0", 64)},
		},
	}
	raw, err := encodeJSON(manifest)
	require.NoError(t, err)
	entry, err := writer.Create(ManifestName)
	require.NoError(t, err)
	_, err = entry.Write(raw)
	require.NoError(t, err)
	dataEntry, err := writer.Create("a.txt")
	require.NoError(t, err)
	_, err = dataEntry.Write([]byte("x"))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	require.NoError(t, file.Close())

	service, err := NewService(Config{BackupDir: dir})
	require.NoError(t, err)
	_, err = service.VerifyBackup(path)
	require.ErrorIs(t, err, ErrChecksumMismatch)
}

func TestVerifyRejectsGarbage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.zip")
	require.NoError(t, os.WriteFile(path, []byte("not a zip"), 0o644))
	service, err := NewService(Config{BackupDir: dir})
	require.NoError(t, err)
	_, err = service.VerifyBackup(path)
	require.Error(t, err)
	require.True(t, errors.Is(err, ErrInvalidArchive))
}
