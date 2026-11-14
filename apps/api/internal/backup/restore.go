package backup

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"entgo.io/ent/dialect/sql/schema"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
)

// RestoreOptions describes one restore run.
//
// Restore is a CLI operation: replacing the file a running process has open is
// not safe, and this package cannot make it safe from inside that process. The
// safety backup id is required for a non-empty database so the caller cannot
// forget the automatic pre-restore snapshot.
type RestoreOptions struct {
	ArchivePath  string
	TargetDBPath string
	MediaRoots   []MediaRoot
	// Confirm allows replacing a non-empty database.
	Confirm bool
	// SkipMedia restores only the database.
	SkipMedia bool
	// SafetyBackupID names the backup this same package created immediately
	// before the restore. It is required for a non-empty database.
	SafetyBackupID string
	// SchemaVersion is the version this binary expects. Empty uses the value the
	// service was built with.
	SchemaVersion string
}

// RestoreResult reports what was replaced and verified.
type RestoreResult struct {
	SafetyBackupID string   `json:"safety_backup_id"`
	DatabasePath   string   `json:"database_path"`
	MediaFiles     int      `json:"media_files"`
	Sites          int      `json:"sites"`
	Users          int      `json:"users"`
	Content        int      `json:"content"`
	SchemaVersion  string   `json:"schema_version"`
	Migrated       bool     `json:"migrated"`
	Warnings       []string `json:"warnings,omitempty"`
}

// SQLitePathFromDSN extracts the file path a SQLite DSN points at.
//
// Restore cannot reuse the live handle: it has to replace the file. Parsing the
// DSN here keeps the CLI from asking the operator to type the path twice, and
// rejects in-memory databases explicitly because there is nothing to replace.
func SQLitePathFromDSN(dsn string) (string, error) {
	raw := strings.TrimSpace(dsn)
	if raw == "" {
		return "", fmt.Errorf("%w: DATABASE_DSN is empty", ErrInvalidInput)
	}
	if raw == ":memory:" {
		return "", fmt.Errorf("%w: in-memory databases cannot be restored", ErrInvalidInput)
	}
	raw = strings.TrimPrefix(raw, "file:")
	if i := strings.IndexByte(raw, '?'); i >= 0 {
		raw = raw[:i]
	}
	if raw == "" || raw == ":memory:" || strings.HasPrefix(raw, ":memory:") {
		return "", fmt.Errorf("%w: in-memory databases cannot be restored", ErrInvalidInput)
	}
	// file://host/path is a network path in URI form; refuse it rather than
	// turning it into a local path by accident.
	if strings.HasPrefix(raw, "//") {
		return "", fmt.Errorf("%w: file URI host is not supported for restore", ErrInvalidInput)
	}
	unescaped, err := url.PathUnescape(raw)
	if err != nil {
		return "", fmt.Errorf("%w: malformed SQLite path: %v", ErrInvalidInput, err)
	}
	return filepath.FromSlash(unescaped), nil
}

// Restore replaces a SQLite database and local media roots from a backup.
func (s *Service) Restore(ctx context.Context, opts RestoreOptions) (RestoreResult, error) {
	// Resolve the package once. An encrypted package is authenticated and
	// decrypted to a temporary zip here, so a missing or wrong key fails before
	// anything on disk is touched and every later step reads the plaintext copy.
	archivePath, cleanup, err := s.prepareArchive(opts.ArchivePath)
	if err != nil {
		return RestoreResult{}, err
	}
	defer cleanup()
	manifest, err := s.verifyPlainArchive(archivePath)
	if err != nil {
		return RestoreResult{}, err
	}
	if manifest.Database.Driver != "sqlite" || manifest.Database.Dialect != "sqlite" {
		return RestoreResult{}, errUnsupported(manifest.Database.Driver)
	}
	currentSchema := opts.SchemaVersion
	if currentSchema == "" {
		currentSchema = s.schemaVersion
	}
	if manifest.SchemaVersion != "" && currentSchema != "" && currentSchema != "unknown" {
		if manifest.SchemaVersion > currentSchema {
			return RestoreResult{}, fmt.Errorf(
				"%w: package schema %s is newer than this binary's %s",
				ErrInvalidInput, manifest.SchemaVersion, currentSchema,
			)
		}
	}
	if strings.TrimSpace(opts.TargetDBPath) == "" {
		return RestoreResult{}, fmt.Errorf("%w: target database path is required", ErrInvalidInput)
	}

	handle, stats, err := inspectDatabase(ctx, opts.TargetDBPath)
	if err != nil {
		return RestoreResult{}, err
	}
	nonEmpty := stats.SchemaReady && (stats.Sites+stats.Users+stats.Content) > 0
	if nonEmpty && !opts.Confirm {
		if handle != nil {
			_ = handle.Close()
		}
		return RestoreResult{}, fmt.Errorf(
			"%w: target has %d sites, %d users and %d content items; pass --confirm",
			ErrConfirmationRequired, stats.Sites, stats.Users, stats.Content,
		)
	}
	if nonEmpty && strings.TrimSpace(opts.SafetyBackupID) == "" {
		if handle != nil {
			_ = handle.Close()
		}
		return RestoreResult{}, fmt.Errorf(
			"%w: a safety backup must be created before replacing a non-empty database",
			ErrInvalidInput,
		)
	}
	if opts.SafetyBackupID != "" {
		if _, err := s.readArtifact(opts.SafetyBackupID); err != nil {
			if handle != nil {
				_ = handle.Close()
			}
			return RestoreResult{}, fmt.Errorf("backup: safety backup %s: %w", opts.SafetyBackupID, err)
		}
	}
	if handle != nil {
		if err := handle.Close(); err != nil {
			return RestoreResult{}, err
		}
	}

	result := RestoreResult{
		SafetyBackupID: opts.SafetyBackupID,
		DatabasePath:   opts.TargetDBPath,
		SchemaVersion:  currentSchema,
	}
	if !opts.SkipMedia {
		files, warnings, mediaErr := extractMedia(ctx, archivePath, opts.MediaRoots)
		if mediaErr != nil {
			return RestoreResult{}, mediaErr
		}
		result.MediaFiles = files
		result.Warnings = append(result.Warnings, warnings...)
	}

	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("%w: reopen package: %v", ErrInvalidArchive, err)
	}
	defer reader.Close()

	dumpFile, ok := findZipFile(&reader.Reader, manifest.Database.Dump)
	if !ok {
		return RestoreResult{}, fmt.Errorf("%w: database dump is missing", ErrInvalidArchive)
	}
	targetDir := filepath.Dir(opts.TargetDBPath)
	if err := os.MkdirAll(targetDir, 0o750); err != nil {
		return RestoreResult{}, err
	}
	tempDump, err := os.CreateTemp(targetDir, ".restore-*.db")
	if err != nil {
		return RestoreResult{}, err
	}
	tempPath := tempDump.Name()
	defer os.Remove(tempPath)
	if err := copyVerifiedEntry(dumpFile, tempDump, manifest.Database.Size, manifest.Database.SHA256); err != nil {
		_ = tempDump.Close()
		return RestoreResult{}, err
	}
	if err := tempDump.Sync(); err != nil {
		_ = tempDump.Close()
		return RestoreResult{}, err
	}
	if err := tempDump.Close(); err != nil {
		return RestoreResult{}, err
	}

	previousPath, err := replaceDatabaseFile(opts.TargetDBPath, tempPath)
	if err != nil {
		return RestoreResult{}, err
	}
	// The WAL and shared memory files belong to the old database; leaving them
	// behind would splice an old write-ahead log onto the restored file.
	_ = os.Remove(opts.TargetDBPath + "-wal")
	_ = os.Remove(opts.TargetDBPath + "-shm")

	restored, err := db.Open(ctx, "sqlite", db.SQLiteDSN(opts.TargetDBPath))
	if err != nil {
		rollbackDatabase(opts.TargetDBPath, previousPath)
		return RestoreResult{}, fmt.Errorf("backup: open restored database: %w", err)
	}
	defer restored.Close()

	if err := restored.Client.Schema.Create(ctx,
		schema.WithDropColumn(false),
		schema.WithDropIndex(false),
	); err != nil {
		rollbackDatabase(opts.TargetDBPath, previousPath)
		return RestoreResult{}, fmt.Errorf("backup: apply additive schema after restore: %w", err)
	}
	if err := restored.VerifySchema(ctx); err != nil {
		rollbackDatabase(opts.TargetDBPath, previousPath)
		return RestoreResult{}, err
	}
	restoredStats, err := restored.Inspect(ctx)
	if err != nil {
		return RestoreResult{}, err
	}
	result.Sites = restoredStats.Sites
	result.Users = restoredStats.Users
	result.Content = restoredStats.Content
	result.Migrated = manifest.SchemaVersion != "" && manifest.SchemaVersion != currentSchema
	if result.Migrated {
		result.Warnings = append(result.Warnings,
			fmt.Sprintf("package schema %s was migrated to %s", manifest.SchemaVersion, currentSchema))
	}

	if previousPath != "" {
		_ = os.Remove(previousPath)
	}
	return result, nil
}

// inspectDatabase opens the current target when it exists and reports whether it
// holds data. A missing file is an empty target, not an error.
func inspectDatabase(ctx context.Context, target string) (*db.DB, db.Stats, error) {
	if _, err := os.Stat(target); err != nil {
		if os.IsNotExist(err) {
			return nil, db.Stats{}, nil
		}
		return nil, db.Stats{}, err
	}
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(target))
	if err != nil {
		return nil, db.Stats{}, fmt.Errorf("backup: open target database: %w", err)
	}
	stats, err := handle.Inspect(ctx)
	if err != nil {
		_ = handle.Close()
		return nil, db.Stats{}, err
	}
	return handle, stats, nil
}

// replaceDatabaseFile moves the current file aside and installs the new one.
//
// The old file is kept until the caller has verified the restored database, so a
// failed migration can be rolled back without consulting the package again.
func replaceDatabaseFile(target, replacement string) (string, error) {
	previous := ""
	if _, err := os.Stat(target); err == nil {
		previous = target + ".pre-restore-" + time.Now().UTC().Format("20060102-150405")
		if err := os.Rename(target, previous); err != nil {
			return "", fmt.Errorf("backup: move current database aside: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(replacement, target); err != nil {
		if previous != "" {
			_ = os.Rename(previous, target)
		}
		return "", fmt.Errorf("backup: install restored database: %w", err)
	}
	return previous, nil
}

// rollbackDatabase puts the pre-restore file back after a failed verification.
func rollbackDatabase(target, previous string) {
	_ = os.Remove(target)
	_ = os.Remove(target + "-wal")
	_ = os.Remove(target + "-shm")
	if previous != "" {
		_ = os.Rename(previous, target)
	}
}

// findZipFile looks up one entry by exact path.
func findZipFile(reader *zip.Reader, entryPath string) (*zip.File, bool) {
	for _, file := range reader.File {
		if file.Name == entryPath {
			return file, true
		}
	}
	return nil, false
}

// copyVerifiedEntry copies one zip entry to an open file, checking size and hash.
func copyVerifiedEntry(file *zip.File, destination *os.File, size int64, expected string) error {
	stream, err := file.Open()
	if err != nil {
		return err
	}
	defer stream.Close()
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(destination, hasher), stream)
	if err != nil {
		return err
	}
	if written != size {
		return fmt.Errorf("%w: database dump size is %d, manifest says %d",
			ErrChecksumMismatch, written, size)
	}
	if got := hex.EncodeToString(hasher.Sum(nil)); got != expected {
		return fmt.Errorf("%w: database dump is %s, manifest says %s",
			ErrChecksumMismatch, got, expected)
	}
	return nil
}

// extractMedia writes every media/<alias>/... entry back to its configured
// local root. Missing roots are an error unless the operator asked to skip
// media: silently dropping photos after a restore is worse than failing.
func extractMedia(
	ctx context.Context,
	archivePath string,
	roots []MediaRoot,
) (int, []string, error) {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return 0, nil, fmt.Errorf("%w: open package: %v", ErrInvalidArchive, err)
	}
	defer reader.Close()

	targets := make(map[string]MediaRoot, len(roots))
	for _, root := range roots {
		if root.Driver == "local" && root.Dir != "" {
			absolute, err := filepath.Abs(root.Dir)
			if err != nil {
				return 0, nil, err
			}
			targets[root.Alias] = MediaRoot{Alias: root.Alias, Driver: root.Driver, Dir: absolute}
		}
	}

	count := 0
	warnings := make([]string, 0)
	for _, file := range reader.File {
		if !strings.HasPrefix(file.Name, "media/") || file.FileInfo().IsDir() {
			continue
		}
		if err := ctx.Err(); err != nil {
			return count, warnings, err
		}
		remainder := strings.TrimPrefix(file.Name, "media/")
		parts := strings.SplitN(remainder, "/", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return count, warnings, fmt.Errorf("%w: malformed media entry %q", ErrInvalidArchive, file.Name)
		}
		root, ok := targets[parts[0]]
		if !ok {
			return count, warnings, fmt.Errorf(
				"%w: package has media for root %q but this deployment has no local root with that name; "+
					"pass --skip-media to restore the database only",
				ErrInvalidInput, parts[0],
			)
		}
		relative := filepath.FromSlash(parts[1])
		clean := filepath.Clean(relative)
		if clean == "." || strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
			return count, warnings, fmt.Errorf("%w: unsafe media path %q", ErrInvalidArchive, file.Name)
		}
		target := filepath.Join(root.Dir, clean)
		contained, err := filepath.Rel(root.Dir, target)
		if err != nil || strings.HasPrefix(contained, "..") {
			return count, warnings, fmt.Errorf("%w: media path escapes root: %q", ErrInvalidArchive, file.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return count, warnings, err
		}
		stream, err := file.Open()
		if err != nil {
			return count, warnings, err
		}
		temp, err := os.CreateTemp(filepath.Dir(target), ".restore-media-*")
		if err != nil {
			_ = stream.Close()
			return count, warnings, err
		}
		tempName := temp.Name()
		if _, err := io.Copy(temp, stream); err != nil {
			_ = stream.Close()
			_ = temp.Close()
			_ = os.Remove(tempName)
			return count, warnings, err
		}
		if err := stream.Close(); err != nil {
			_ = temp.Close()
			_ = os.Remove(tempName)
			return count, warnings, err
		}
		if err := temp.Close(); err != nil {
			_ = os.Remove(tempName)
			return count, warnings, err
		}
		if err := os.Rename(tempName, target); err != nil {
			_ = os.Remove(tempName)
			return count, warnings, err
		}
		count++
	}
	if len(targets) == 0 && count > 0 {
		return count, warnings, errors.New("backup: no local media roots configured")
	}
	return count, warnings, nil
}
