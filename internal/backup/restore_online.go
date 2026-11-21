package backup

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
)

// OnlineRestorer is the live database half of an in-process restore. *db.DB
// implements it with SQLite's backup API.
type OnlineRestorer interface {
	RestoreFrom(ctx context.Context, sourcePath string) error
	EnsureSchema(ctx context.Context) error
	VerifySchema(ctx context.Context) error
	Inspect(ctx context.Context) (db.Stats, error)
}

// RestoreFailure reports a restore that started but did not finish. The safety
// backup is always named so the operator can retry even when the rollback also
// failed.
type RestoreFailure struct {
	SafetyBackupID string
	RolledBack     bool
	Err            error
}

func (e *RestoreFailure) Error() string {
	if e == nil {
		return ErrRestoreFailed.Error()
	}
	return fmt.Sprintf("%s: %v (safety backup %s)", ErrRestoreFailed, e.Err, e.SafetyBackupID)
}

func (e *RestoreFailure) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// RestoreStored restores one stored package into the live SQLite database and
// local media roots.
//
// The call is deliberately platform-admin only and does not consult the site's
// high-threat switch: the HTTP handler always requires a step-up grant. The
// service repeats the role check so a future caller cannot bypass it.
func (s *Service) RestoreStored(
	ctx context.Context,
	backupID string,
	actor Actor,
	requestID string,
) (result RestoreResult, restoreErr error) {
	if err := requirePlatformAdmin(actor); err != nil {
		return RestoreResult{}, err
	}
	if s.driver != "sqlite" {
		return RestoreResult{}, fmt.Errorf("%w: driver=%s", ErrRestoreUnsupported, s.driver)
	}
	if s.online == nil {
		return RestoreResult{}, fmt.Errorf("%w: live database handle is not configured", ErrRestoreUnsupported)
	}
	targetPath, err := SQLitePathFromDSN(s.dsn)
	if err != nil {
		return RestoreResult{}, err
	}

	// A disconnected browser must not interrupt a destructive operation halfway
	// through. Preserve request values but drop cancellation and deadlines.
	ctx = context.WithoutCancel(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()

	var safetyID string
	defer func() {
		s.recordRestoreAudit(actor, backupID, result, restoreErr, safetyID, requestID)
	}()

	artifact, err := s.readArtifact(backupID)
	if err != nil {
		return RestoreResult{}, err
	}
	if artifact.Driver != "" && artifact.Driver != "sqlite" {
		return RestoreResult{}, fmt.Errorf("%w: package driver=%s", ErrRestoreUnsupported, artifact.Driver)
	}

	archivePath, cleanup, err := s.prepareArchive(artifact.Path)
	if err != nil {
		return RestoreResult{}, err
	}
	defer cleanup()
	manifest, err := s.verifyPlainArchive(archivePath)
	if err != nil {
		return RestoreResult{}, err
	}
	if manifest.Database.Driver != "sqlite" || manifest.Database.Dialect != "sqlite" {
		return RestoreResult{}, fmt.Errorf(
			"%w: package database driver=%s dialect=%s",
			ErrRestoreUnsupported, manifest.Database.Driver, manifest.Database.Dialect,
		)
	}
	currentSchema := s.schemaVersion
	if manifest.SchemaVersion != "" && currentSchema != "" && currentSchema != "unknown" {
		if manifest.SchemaVersion > currentSchema {
			return RestoreResult{}, fmt.Errorf(
				"%w: package schema %s is newer than this binary's %s",
				ErrInvalidInput, manifest.SchemaVersion, currentSchema,
			)
		}
	}

	// The package is verified before anything is touched. The safety backup is
	// manual origin, so the scheduler never prunes it.
	safety, err := s.createBackup(ctx, OriginManual)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("backup: create pre-restore safety backup: %w", err)
	}
	safetyID = safety.ID

	result, restoreErr = s.restoreOnlineStaged(ctx, archivePath, manifest, targetPath, currentSchema, safetyID)
	return result, restoreErr
}

// restoreOnlineStaged performs the destructive half after the package and safety
// backup have been verified. It must be called with Service.mu held.
func (s *Service) restoreOnlineStaged(
	ctx context.Context,
	archivePath string,
	manifest BackupManifest,
	targetPath string,
	currentSchema string,
	safetyID string,
) (RestoreResult, error) {
	tempPath, cleanup, err := stageDatabaseDump(archivePath, manifest, filepath.Dir(targetPath))
	if err != nil {
		return RestoreResult{}, fmt.Errorf("backup: stage restored database: %w", err)
	}
	defer cleanup()

	result := RestoreResult{
		SafetyBackupID: safetyID,
		DatabasePath:   targetPath,
		SchemaVersion:  currentSchema,
	}
	if err := s.online.RestoreFrom(ctx, tempPath); err != nil {
		return RestoreResult{}, s.failRestore(ctx, safetyID, fmt.Errorf("backup: apply restored database: %w", err))
	}
	if err := s.online.EnsureSchema(ctx); err != nil {
		return RestoreResult{}, s.failRestore(ctx, safetyID, fmt.Errorf("backup: apply additive schema after restore: %w", err))
	}
	if err := s.online.VerifySchema(ctx); err != nil {
		return RestoreResult{}, s.failRestore(ctx, safetyID, fmt.Errorf("backup: verify restored database: %w", err))
	}
	stats, err := s.online.Inspect(ctx)
	if err != nil {
		return RestoreResult{}, s.failRestore(ctx, safetyID, fmt.Errorf("backup: inspect restored database: %w", err))
	}
	result.Sites = stats.Sites
	result.Users = stats.Users
	result.Content = stats.Content
	result.Migrated = manifest.SchemaVersion != "" && manifest.SchemaVersion != currentSchema
	if result.Migrated {
		result.Warnings = append(result.Warnings,
			fmt.Sprintf("package schema %s was migrated to %s", manifest.SchemaVersion, currentSchema))
	}
	if len(manifest.Warnings) > 0 {
		result.Warnings = append(result.Warnings, manifest.Warnings...)
	}

	files, warnings, err := extractMedia(ctx, archivePath, s.mediaRootList())
	if err != nil {
		return RestoreResult{}, s.failRestore(ctx, safetyID, fmt.Errorf("backup: restore media: %w", err))
	}
	result.MediaFiles = files
	result.Warnings = append(result.Warnings, warnings...)
	return result, nil
}

// failRestore rolls the database back from safetyID and returns a structured
// failure. A failed rollback is reported, never hidden: the caller still learns
// which safety package to use.
func (s *Service) failRestore(ctx context.Context, safetyID string, cause error) error {
	rollbackErr := s.rollbackOnline(ctx, safetyID)
	failure := &RestoreFailure{SafetyBackupID: safetyID, RolledBack: rollbackErr == nil, Err: cause}
	if rollbackErr != nil {
		failure.Err = fmt.Errorf("%v; rollback from safety backup failed: %w", cause, rollbackErr)
	}
	return failure
}

// rollbackOnline copies the verified safety package back into the live database.
// Media is intentionally not rolled back: old rows keep resolving to old random
// storage keys, and restoring media twice would add no safety.
func (s *Service) rollbackOnline(ctx context.Context, safetyID string) error {
	artifact, err := s.readArtifact(safetyID)
	if err != nil {
		return err
	}
	archivePath, cleanup, err := s.prepareArchive(artifact.Path)
	if err != nil {
		return err
	}
	defer cleanup()
	manifest, err := s.verifyPlainArchive(archivePath)
	if err != nil {
		return err
	}
	if manifest.Database.Driver != "sqlite" || manifest.Database.Dialect != "sqlite" {
		return fmt.Errorf("%w: safety package is not SQLite", ErrRestoreUnsupported)
	}
	tempPath, cleanupDump, err := stageDatabaseDump(archivePath, manifest, s.backupDir)
	if err != nil {
		return err
	}
	defer cleanupDump()
	if err := s.online.RestoreFrom(ctx, tempPath); err != nil {
		return err
	}
	if err := s.online.EnsureSchema(ctx); err != nil {
		return err
	}
	return s.online.VerifySchema(ctx)
}

// recordRestoreAudit is best effort: the restore result is authoritative and an
// audit write failure must not turn a completed restore into an error.
func (s *Service) recordRestoreAudit(
	actor Actor,
	backupID string,
	result RestoreResult,
	restoreErr error,
	safetyID string,
	requestID string,
) {
	if s.audit == nil {
		return
	}
	outcome := "success"
	detail := map[string]any{
		"safety_backup_id": safetyID,
		"database_path":    result.DatabasePath,
		"sites":            result.Sites,
		"users":            result.Users,
		"content":          result.Content,
		"media_files":      result.MediaFiles,
		"schema_version":   result.SchemaVersion,
		"migrated":         result.Migrated,
	}
	if restoreErr != nil {
		outcome = "failure"
		detail["error"] = restoreErr.Error()
		var failure *RestoreFailure
		if errors.As(restoreErr, &failure) {
			detail["rolled_back"] = failure.RolledBack
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.audit.Record(ctx, audit.Entry{
		SiteID:     actor.SiteID,
		ActorID:    actor.UserID,
		Action:     "backup.restore",
		TargetType: "backup",
		TargetID:   backupID,
		RequestID:  requestID,
		Outcome:    outcome,
		Detail:     detail,
		At:         s.now(),
	})
}
