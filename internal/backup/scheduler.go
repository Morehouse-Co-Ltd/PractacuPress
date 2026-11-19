// Automatic backup scheduling (Beta 1.2 contract L).
//
// The schedule is environment configuration, exactly like the storage and mail
// settings: an operator picks an hour and a retention count in .env, the process
// runs one background loop, and GET /system/backup-schedule reports what the
// loop is actually doing. Nothing about a run is persisted separately: the
// artifacts on disk plus the last run status in memory are the whole state, so a
// restart cannot leave a stale "scheduled" row behind.
package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/site"
)

// Defaults of the automatic backup schedule, matching the contract.
const (
	// DefaultAutoHour is the documented default BACKUP_AUTO_HOUR.
	DefaultAutoHour = 3
	// DefaultAutoKeep is the documented default BACKUP_AUTO_KEEP.
	DefaultAutoKeep = 7
	// DefaultAutoCheckInterval is how often the loop asks whether the scheduled
	// hour has arrived. Checking hourly keeps a missed run cheap to recover: the
	// loop catches up on its next tick instead of waiting a whole day.
	DefaultAutoCheckInterval = time.Hour
)

// Environment variable names of the schedule.
const (
	EnvAutoEnabled = "BACKUP_AUTO_ENABLED"
	EnvAutoHour    = "BACKUP_AUTO_HOUR"
	EnvAutoKeep    = "BACKUP_AUTO_KEEP"
)

// Run status values reported by the schedule endpoint.
const (
	// RunStatusOK means the last run produced a package.
	RunStatusOK = "ok"
	// RunStatusFailed means the last run failed; LastError says why.
	RunStatusFailed = "failed"
)

// ErrSchedulerBusy means a run is already in progress. It is not a failure of
// the schedule: two loops must never write packages at the same time.
var ErrSchedulerBusy = errors.New("backup: an automatic backup is already running")

// SchedulerOptions configures a Scheduler.
//
// Hour and Keep are used as given when the struct is built by hand (Hour 0 is
// midnight); EnvSchedulerOptions applies the documented defaults and rejects
// out of range values so a typo in .env fails the process at boot instead of
// silently scheduling at the wrong time.
type SchedulerOptions struct {
	Enabled bool
	Hour    int
	Keep    int
	// Interval overrides DefaultAutoCheckInterval.
	Interval time.Duration
	// Now is the clock. Nil uses the wall clock.
	Now func() time.Time
	// Logger receives run failures. Nil discards them.
	Logger *slog.Logger
	// Audit receives one entry per run (success or failure). Nil records nothing.
	Audit audit.Recorder
}

// ScheduleArtifact is one stored package in the schedule view.
type ScheduleArtifact struct {
	Name      string    `json:"name"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"created_at"`
}

// ScheduleStatus is the GET /system/backup-schedule payload.
type ScheduleStatus struct {
	Enabled    bool               `json:"enabled"`
	Hour       int                `json:"hour"`
	Keep       int                `json:"keep"`
	LastRunAt  *time.Time         `json:"last_run_at,omitempty"`
	LastStatus string             `json:"last_status,omitempty"`
	LastError  string             `json:"last_error,omitempty"`
	NextRunAt  *time.Time         `json:"next_run_at,omitempty"`
	Artifacts  []ScheduleArtifact `json:"artifacts"`
}

// Scheduler runs the automatic backup loop.
//
// It is safe for concurrent use: Status may be read while a run is in progress,
// and a second run is refused instead of racing the first one's package write.
type Scheduler struct {
	service  *Service
	enabled  bool
	hour     int
	keep     int
	interval time.Duration
	now      func() time.Time
	logger   *slog.Logger
	audit    audit.Recorder

	mu         sync.Mutex
	running    bool
	lastRunAt  *time.Time
	lastStatus string
	lastError  string
}

// EnvSchedulerOptions reads BACKUP_AUTO_ENABLED, BACKUP_AUTO_HOUR and
// BACKUP_AUTO_KEEP, applying the documented defaults. Invalid values are an
// error: a schedule the operator did not intend is worse than a refused boot.
func EnvSchedulerOptions() (SchedulerOptions, error) {
	options := SchedulerOptions{Enabled: false, Hour: DefaultAutoHour, Keep: DefaultAutoKeep}

	switch strings.ToLower(strings.TrimSpace(os.Getenv(EnvAutoEnabled))) {
	case "", "0", "false", "off", "no":
	case "1", "true", "on", "yes":
		options.Enabled = true
	default:
		return SchedulerOptions{}, fmt.Errorf("%w: %s must be on or off", ErrInvalidInput, EnvAutoEnabled)
	}

	if raw := strings.TrimSpace(os.Getenv(EnvAutoHour)); raw != "" {
		hour, err := strconv.Atoi(raw)
		if err != nil || hour < 0 || hour > 23 {
			return SchedulerOptions{}, fmt.Errorf(
				"%w: %s must be an integer between 0 and 23", ErrInvalidInput, EnvAutoHour)
		}
		options.Hour = hour
	}
	if raw := strings.TrimSpace(os.Getenv(EnvAutoKeep)); raw != "" {
		keep, err := strconv.Atoi(raw)
		if err != nil || keep < 1 {
			return SchedulerOptions{}, fmt.Errorf(
				"%w: %s must be a positive integer", ErrInvalidInput, EnvAutoKeep)
		}
		options.Keep = keep
	}
	return options, nil
}

// NewScheduler validates the options and builds the loop.
func NewScheduler(service *Service, options SchedulerOptions) (*Scheduler, error) {
	if service == nil {
		return nil, fmt.Errorf("%w: a backup service is required", ErrInvalidInput)
	}
	if options.Hour < 0 || options.Hour > 23 {
		return nil, fmt.Errorf("%w: the backup hour must be between 0 and 23", ErrInvalidInput)
	}
	keep := options.Keep
	if keep <= 0 {
		keep = DefaultAutoKeep
	}
	interval := options.Interval
	if interval <= 0 {
		interval = DefaultAutoCheckInterval
	}
	now := options.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Scheduler{
		service:  service,
		enabled:  options.Enabled,
		hour:     options.Hour,
		keep:     keep,
		interval: interval,
		now:      now,
		logger:   logger,
		audit:    options.Audit,
	}, nil
}

// Start runs the schedule until ctx is cancelled.
//
// It is blocking by design; the composition root starts it with `go
// scheduler.Start(ctx)`. A disabled schedule returns immediately, so the caller
// needs no branch of its own.
func (s *Scheduler) Start(ctx context.Context) {
	if s == nil {
		return
	}
	if !s.enabled {
		s.logger.Info("automatic backups are disabled", "hour", s.hour, "keep", s.keep)
		return
	}
	s.logger.Info("automatic backup scheduler started", "hour", s.hour, "keep", s.keep)
	// Check once at startup: a process that boots after the scheduled hour must
	// catch up on the same day instead of waiting for the next tick.
	s.check(ctx)

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.logger.Info("automatic backup scheduler stopped")
			return
		case <-ticker.C:
			s.check(ctx)
		}
	}
}

// check runs the backup when the schedule is due.
func (s *Scheduler) check(ctx context.Context) {
	if !s.shouldRun(s.now()) {
		return
	}
	if _, err := s.RunOnce(ctx); err != nil {
		if errors.Is(err, ErrSchedulerBusy) {
			return
		}
		s.logger.Error("automatic backup failed", "error", err)
	}
}

// shouldRun reports whether this calendar occurrence was already served.
//
// The comparison is against today's configured instant rather than a duration:
// an operator expects "the backup runs at 03:00" to mean once per day even if
// the process restarts several times, and a run that started today at 03:05
// covers today's occurrence.
func (s *Scheduler) shouldRun(now time.Time) bool {
	due, passed := scheduleDue(now, s.hour)
	if !passed {
		return false
	}
	s.mu.Lock()
	lastRun := s.lastRunAt
	s.mu.Unlock()
	return lastRun == nil || lastRun.Before(due)
}

// RunOnce creates one backup, prunes older artifacts and records the outcome.
//
// Retention runs only after a successful creation: deleting a package is only
// safe when a newer one exists, otherwise a failing backup would erase history.
func (s *Scheduler) RunOnce(ctx context.Context) (Artifact, error) {
	if s == nil || s.service == nil {
		return Artifact{}, fmt.Errorf("%w: a backup service is required", ErrInvalidInput)
	}
	if !s.beginRun() {
		return Artifact{}, ErrSchedulerBusy
	}
	defer s.endRun()

	startedAt := s.now()
	artifact, err := s.service.CreateAutomaticBackup(ctx)

	var deleted []string
	if err == nil {
		removed, pruneErr := s.prune(ctx)
		deleted = removed
		if pruneErr != nil {
			// The backup exists; a retention failure is logged but must not turn a
			// successful run into a failed one.
			s.logger.Warn("prune old automatic backups failed", "error", pruneErr)
		}
	}

	s.finish(err)
	s.recordAudit(artifact, err, deleted, startedAt)
	return artifact, err
}

// beginRun claims the run slot. The mutex is only held around the flag so a
// multi minute package build never blocks Status.
func (s *Scheduler) beginRun() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return false
	}
	s.running = true
	return true
}

// endRun releases the run slot.
func (s *Scheduler) endRun() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = false
}

// finish stores the last run outcome for Status and the next shouldRun check.
func (s *Scheduler) finish(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	at := s.now()
	s.lastRunAt = &at
	if err != nil {
		s.lastStatus = RunStatusFailed
		s.lastError = err.Error()
		return
	}
	s.lastStatus = RunStatusOK
	s.lastError = ""
}

// recordAudit writes one audit row per run. A logging failure never fails the
// run: the artifact on disk is the source of truth.
func (s *Scheduler) recordAudit(artifact Artifact, runErr error, deleted []string, startedAt time.Time) {
	if s.audit == nil {
		return
	}
	outcome := "success"
	detail := map[string]any{
		"hour":       s.hour,
		"keep":       s.keep,
		"started_at": startedAt.UTC(),
		"deleted":    deleted,
	}
	if runErr != nil {
		outcome = "failure"
		detail["error"] = runErr.Error()
	} else {
		detail["file_name"] = artifact.FileName
		detail["size"] = artifact.Size
		detail["sha256"] = artifact.SHA256
	}
	entry := audit.Entry{
		Action:     "backup.auto_run",
		TargetType: "backup",
		TargetID:   artifact.ID,
		Outcome:    outcome,
		Detail:     detail,
		At:         s.now(),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.audit.Record(ctx, entry); err != nil {
		s.logger.Warn("record automatic backup audit entry failed", "error", err)
	}
}

// prune deletes every scheduler-created package beyond the newest Keep ones and
// returns the removed artifact ids.
//
// Manual packages (the pre-upgrade backup an operator takes) are never counted or
// deleted: retention belongs to the schedule, not to the whole backup directory.
func (s *Scheduler) prune(ctx context.Context) ([]string, error) {
	artifacts, err := s.service.ListBackups(ctx, Actor{Role: site.RolePlatformAdmin})
	if err != nil {
		return nil, err
	}
	automatic := make([]Artifact, 0, len(artifacts))
	for _, artifact := range artifacts {
		if artifact.Origin == OriginAuto {
			automatic = append(automatic, artifact)
		}
	}
	removed := make([]string, 0)
	for index, artifact := range automatic {
		if index < s.keep {
			continue
		}
		if err := s.removeArtifact(artifact); err != nil {
			s.logger.Warn("delete old automatic backup failed",
				"artifact", artifact.ID, "error", err)
			continue
		}
		removed = append(removed, artifact.ID)
	}
	return removed, nil
}

// removeArtifact deletes one package and its metadata sidecar.
//
// The path is checked against the backup directory first: the sidecar on disk is
// input, and a crafted file_name field must not turn retention into a delete
// outside the backup directory.
func (s *Scheduler) removeArtifact(artifact Artifact) error {
	if err := validateArtifactID(artifact.ID); err != nil {
		return err
	}
	if artifact.Path == "" {
		return errors.New("backup: artifact has no path")
	}
	root, err := filepath.Abs(s.service.BackupDir())
	if err != nil {
		return err
	}
	target, err := filepath.Abs(artifact.Path)
	if err != nil {
		return err
	}
	if filepath.Dir(target) != root {
		return fmt.Errorf("backup: refusing to delete %q outside the backup directory", target)
	}
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	meta := filepath.Join(root, artifact.ID+".meta.json")
	if err := os.Remove(meta); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Status builds the schedule view. Listing the artifacts is best effort: a
// transient directory read failure must not break the whole endpoint.
func (s *Scheduler) Status(ctx context.Context) ScheduleStatus {
	if s == nil {
		return ScheduleStatus{Artifacts: []ScheduleArtifact{}}
	}
	s.mu.Lock()
	status := ScheduleStatus{
		Enabled:    s.enabled,
		Hour:       s.hour,
		Keep:       s.keep,
		LastStatus: s.lastStatus,
		LastError:  s.lastError,
		Artifacts:  []ScheduleArtifact{},
	}
	if s.lastRunAt != nil {
		runAt := *s.lastRunAt
		status.LastRunAt = &runAt
	}
	s.mu.Unlock()

	if s.enabled {
		next := NextRun(s.now(), s.hour).UTC()
		status.NextRunAt = &next
	}
	artifacts, err := s.service.ListBackups(ctx, Actor{Role: site.RolePlatformAdmin})
	if err != nil {
		s.logger.Warn("list automatic backup artifacts failed", "error", err)
		return status
	}
	for _, artifact := range artifacts {
		status.Artifacts = append(status.Artifacts, ScheduleArtifact{
			Name:      artifact.FileName,
			Size:      artifact.Size,
			CreatedAt: artifact.CreatedAt.UTC(),
		})
	}
	return status
}

// scheduleDue returns today's configured instant and whether now is at or past it.
func scheduleDue(now time.Time, hour int) (time.Time, bool) {
	if hour < 0 || hour > 23 {
		hour = DefaultAutoHour
	}
	due := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, now.Location())
	return due, !now.Before(due)
}

// NextRun returns the next instant the schedule fires after now, interpreted in
// now's location. It is exported so tests and operators can reason about the
// schedule without reproducing the loop.
func NextRun(now time.Time, hour int) time.Time {
	if hour < 0 || hour > 23 {
		hour = DefaultAutoHour
	}
	due := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, now.Location())
	if now.Before(due) {
		return due
	}
	// AddDate keeps the local clock time across daylight saving changes, which a
	// fixed 24h addition would not.
	return due.AddDate(0, 0, 1)
}
