// Command backup creates, verifies and restores Practacu Press backup packages.
//
// Restore is deliberately a CLI operation: replacing the SQLite file a running
// server has open is not safe. The command closes its own handle, verifies the
// package first, writes an automatic safety backup of a non-empty database, and
// only then replaces the file and the local media roots.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/backup"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
)

const commandTimeout = 30 * time.Minute

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "backup failed: %v\n", err)
		os.Exit(1)
	}
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func run(args []string) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		usage()
		return nil
	}
	command := args[0]
	flags := flag.NewFlagSet("backup "+command, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)

	driver := flags.String("driver", env("DATABASE_DRIVER", "sqlite"), "database driver: sqlite, mysql, postgres")
	dsn := flags.String("dsn", env("DATABASE_DSN", ""), "database connection string")
	mediaDir := flags.String("media-dir", env("STORAGE_DIR", "./data/media"), "global local media root")
	backupDir := flags.String("backup-dir", env("BACKUP_DIR", "./data/backups"), "directory for backup packages")
	out := flags.String("out", "", "create: copy the package to this path")
	in := flags.String("in", "", "verify/restore: package to read")
	targetDB := flags.String("db", "", "restore: database file to replace (defaults to the DSN path)")
	confirm := flags.Bool("confirm", false, "restore: allow replacing a non-empty database")
	skipMedia := flags.Bool("skip-media", false, "restore: replace the database only")
	scopeDirs := &multiFlag{}
	flags.Var(scopeDirs, "scope-dir", "alias=path; repeat for per-purpose local media roots")
	keyValue := flags.String(
		"key",
		env("BACKUP_ENCRYPTION_KEY", ""),
		"encryption key: 64 hex characters, base64, or 32 raw bytes (env BACKUP_ENCRYPTION_KEY)",
	)
	encrypt := flags.Bool(
		"encrypt",
		false,
		"create: encrypt the package as .ppbak; requires --key or BACKUP_ENCRYPTION_KEY",
	)

	if err := flags.Parse(args[1:]); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()

	switch command {
	case "create":
		return create(ctx, *driver, *dsn, *mediaDir, *backupDir, *out, scopeDirs.values, *keyValue, *encrypt)
	case "verify":
		return verify(*in, *keyValue)
	case "restore":
		return restore(ctx, *driver, *dsn, *mediaDir, *backupDir, *in, *targetDB, *confirm, *skipMedia, scopeDirs.values, *keyValue)
	default:
		usage()
		return fmt.Errorf("unknown command %q", command)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `Practacu Press backup

Usage:
  go run ./cmd/backup create  [--dsn DSN] [--media-dir DIR] [--backup-dir DIR] [--out FILE] [--encrypt] [--key KEY]
  go run ./cmd/backup verify  --in FILE [--key KEY]
  go run ./cmd/backup restore --in FILE [--confirm] [--skip-media] [--db FILE] [--key KEY]

Environment defaults: DATABASE_DRIVER, DATABASE_DSN, STORAGE_DIR, BACKUP_DIR,
BACKUP_ENCRYPTION_KEY.

create writes database/practacu.db (SQLite VACUUM INTO), local media, every
site design document and a per-entry SHA-256 manifest. MySQL and PostgreSQL are
not dumped by this process: use mysqldump or pg_dump for the database and copy
the media directory separately, because no single binary can guarantee
consistency for both without their native tools.

Encryption: a 32-byte AES-256 key (64 hex characters, base64, or 32 raw bytes)
turns whole-instance packages into .ppbak files. create encrypts whenever a key
is configured; --encrypt makes that intent explicit and fails when no key is
set. verify and restore detect an encrypted package by its magic header and
require the same key: a missing or wrong key is a hard error, never a silent
plaintext fallback.

restore refuses to replace a non-empty database unless --confirm is set, and
always creates a safety backup of the current database and media first. If the
package contains media for a root this deployment does not configure, restore
stops and asks for --skip-media instead of silently dropping photos.
`)
}

type multiFlag struct {
	values []string
}

func (m *multiFlag) String() string { return strings.Join(m.values, ",") }

func (m *multiFlag) Set(value string) error {
	if !strings.Contains(value, "=") {
		return fmt.Errorf("expected alias=path, got %q", value)
	}
	m.values = append(m.values, value)
	return nil
}

func mediaRoots(mediaDir string, scopeValues []string) []backup.MediaRoot {
	roots := []backup.MediaRoot{{Alias: "global", Driver: "local", Dir: mediaDir}}
	seen := map[string]bool{"global": true}
	for _, value := range scopeValues {
		parts := strings.SplitN(value, "=", 2)
		alias := strings.TrimSpace(parts[0])
		if alias == "" || seen[alias] {
			continue
		}
		seen[alias] = true
		roots = append(roots, backup.MediaRoot{Alias: alias, Driver: "local", Dir: strings.TrimSpace(parts[1])})
	}
	return roots
}

func newService(
	driver, dsn, backupDir string,
	snapshotter backup.Snapshotter,
	designs backup.DesignSource,
	mediaRootList []backup.MediaRoot,
	encryptionKey []byte,
) (*backup.Service, error) {
	return backup.NewService(backup.Config{
		Driver:        driver,
		DSN:           dsn,
		Snapshotter:   snapshotter,
		Designs:       designs,
		MediaRoots:    mediaRootList,
		BackupDir:     backupDir,
		SchemaVersion: db.SchemaVersion,
		AppVersion:    backup.BuildVersion(),
		EncryptionKey: encryptionKey,
	})
}

func create(
	ctx context.Context,
	driver, dsn, mediaDir, backupDir, out string,
	scopeValues []string,
	keyValue string,
	encrypt bool,
) error {
	if strings.TrimSpace(dsn) == "" {
		return errors.New("--dsn or DATABASE_DSN is required")
	}
	key, err := backup.ParseEncryptionKey(keyValue)
	if err != nil {
		return err
	}
	// Fail closed: a configured key always encrypts, and --encrypt without a key
	// is an error instead of silently producing a plaintext package.
	if key != nil {
		encrypt = true
	}
	if encrypt && key == nil {
		return errors.New("--encrypt requires a key: pass --key or set BACKUP_ENCRYPTION_KEY")
	}
	if !encrypt {
		key = nil
	}
	handle, err := db.Open(ctx, driver, dsn)
	if err != nil {
		return err
	}
	defer handle.Close()

	service, err := newService(
		driver, dsn, backupDir, handle,
		backup.NewDBDesignSource(handle),
		mediaRoots(mediaDir, scopeValues),
		key,
	)
	if err != nil {
		return err
	}
	artifact, err := service.CreateBackup(ctx)
	if err != nil {
		return err
	}
	output := artifact.Path
	if strings.TrimSpace(out) != "" {
		if err := copyFile(artifact.Path, out); err != nil {
			return err
		}
		output = out
	}
	fmt.Printf("backup created: %s\n", output)
	fmt.Printf("  id:        %s\n", artifact.ID)
	fmt.Printf("  size:      %d bytes\n", artifact.Size)
	fmt.Printf("  sha256:    %s\n", artifact.SHA256)
	fmt.Printf("  encrypted: %v\n", artifact.Encrypted)
	fmt.Printf("  media:     %v\n", artifact.IncludesMedia)
	for _, warning := range artifact.Warnings {
		fmt.Printf("  warning: %s\n", warning)
	}
	return nil
}

func verify(path, keyValue string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("--in is required")
	}
	key, err := backup.ParseEncryptionKey(keyValue)
	if err != nil {
		return err
	}
	service, err := backup.NewService(backup.Config{
		BackupDir:     filepath.Dir(path),
		SchemaVersion: db.SchemaVersion,
		EncryptionKey: key,
	})
	if err != nil {
		return err
	}
	manifest, err := service.VerifyBackup(path)
	if err != nil {
		return err
	}
	fmt.Printf("backup verified: %s\n", path)
	fmt.Printf("  format:         %s v%d\n", manifest.Format, manifest.FormatVersion)
	fmt.Printf("  created:        %s\n", manifest.CreatedAt.Format(time.RFC3339))
	fmt.Printf("  schema:         %s\n", manifest.SchemaVersion)
	fmt.Printf("  encrypted:      %v\n", manifest.Encrypted)
	fmt.Printf("  database:       %s (%d bytes)\n", manifest.Database.Dump, manifest.Database.Size)
	fmt.Printf("  entries:        %d\n", len(manifest.Entries))
	fmt.Printf("  designs:        %d\n", len(manifest.Designs))
	fmt.Printf("  content sha256: %s\n", manifest.ContentChecksum)
	for _, warning := range manifest.Warnings {
		fmt.Printf("  warning: %s\n", warning)
	}
	return nil
}

func restore(
	ctx context.Context,
	driver, dsn, mediaDir, backupDir, in, targetDB string,
	confirm, skipMedia bool,
	scopeValues []string,
	keyValue string,
) error {
	if strings.TrimSpace(in) == "" {
		return errors.New("--in is required")
	}
	if driver != "" && driver != "sqlite" {
		return fmt.Errorf(
			"restore only supports SQLite; restore a %s dump with mysql/pg_restore and copy media manually",
			driver,
		)
	}
	key, err := backup.ParseEncryptionKey(keyValue)
	if err != nil {
		return err
	}
	// A restore of an encrypted package must fail before the safety backup, with
	// an actionable message, not part-way through replacing the database.
	if encrypted, err := backup.IsEncryptedPackage(in); err != nil {
		return err
	} else if encrypted && key == nil {
		return errors.New(
			"the package is encrypted; pass --key or set BACKUP_ENCRYPTION_KEY to restore it",
		)
	}
	if strings.TrimSpace(targetDB) == "" {
		resolved, err := backup.SQLitePathFromDSN(dsn)
		if err != nil {
			return err
		}
		targetDB = resolved
	}
	roots := mediaRoots(mediaDir, scopeValues)

	var (
		safetyID string
		handle   *db.DB
		stats    db.Stats
	)
	if _, err := os.Stat(targetDB); err == nil {
		opened, err := db.Open(ctx, "sqlite", db.SQLiteDSN(targetDB))
		if err != nil {
			return err
		}
		handle = opened
		inspection, err := handle.Inspect(ctx)
		if err != nil {
			_ = handle.Close()
			return err
		}
		stats = inspection
	}
	if stats.SchemaReady {
		fmt.Printf("current database: %d sites, %d users, %d content items\n",
			stats.Sites, stats.Users, stats.Content)
	}
	if handle != nil {
		defer handle.Close()
	}

	nonEmpty := stats.SchemaReady && (stats.Sites+stats.Users+stats.Content) > 0
	if nonEmpty && !confirm {
		return fmt.Errorf(
			"target is not empty (%d sites, %d users, %d content items); re-run with --confirm",
			stats.Sites, stats.Users, stats.Content,
		)
	}
	if nonEmpty {
		// The safety backup uses the same key, so an encrypted deployment never
		// leaves a plaintext copy of the database behind during a restore.
		service, err := newService(
			"sqlite", dsn, backupDir, handle,
			backup.NewDBDesignSource(handle), roots, key,
		)
		if err != nil {
			return err
		}
		artifact, err := service.CreateBackup(ctx)
		if err != nil {
			return fmt.Errorf("create automatic safety backup: %w", err)
		}
		safetyID = artifact.ID
		fmt.Printf("safety backup: %s (encrypted=%v)\n", artifact.Path, artifact.Encrypted)
	}
	if handle != nil {
		if err := handle.Close(); err != nil {
			return err
		}
		handle = nil
	}

	service, err := newService("sqlite", dsn, backupDir, nil, nil, roots, key)
	if err != nil {
		return err
	}
	result, err := service.Restore(ctx, backup.RestoreOptions{
		ArchivePath:    in,
		TargetDBPath:   targetDB,
		MediaRoots:     roots,
		Confirm:        confirm,
		SkipMedia:      skipMedia,
		SafetyBackupID: safetyID,
		SchemaVersion:  db.SchemaVersion,
	})
	if err != nil {
		return err
	}
	fmt.Printf("restore complete: %s\n", result.DatabasePath)
	fmt.Printf("  schema:  %s (migrated=%v)\n", result.SchemaVersion, result.Migrated)
	fmt.Printf("  sites:   %d\n", result.Sites)
	fmt.Printf("  users:   %d\n", result.Users)
	fmt.Printf("  content: %d\n", result.Content)
	fmt.Printf("  media:   %d files\n", result.MediaFiles)
	for _, warning := range result.Warnings {
		fmt.Printf("  warning: %s\n", warning)
	}
	return nil
}

func copyFile(source, destination string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
		return err
	}
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o640)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
