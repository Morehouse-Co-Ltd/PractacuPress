package backup

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/site"
	ginmiddleware "github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
)

// fakeSnapshotter writes a tiny "database" copy; it is enough for CreateBackup
// to produce a real package without a SQLite connection.
type fakeSnapshotter struct {
	fail error
}

func (f *fakeSnapshotter) Snapshot(_ context.Context, destPath string) error {
	if f.fail != nil {
		return f.fail
	}
	return os.WriteFile(destPath, []byte("sqlite snapshot"), 0o600)
}

// fakeBackupAudit collects the audit entries the scheduler writes.
type fakeBackupAudit struct {
	mu      sync.Mutex
	entries []audit.Entry
}

func (f *fakeBackupAudit) Record(_ context.Context, entry audit.Entry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entries = append(f.entries, entry)
	return nil
}

func (f *fakeBackupAudit) list() []audit.Entry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]audit.Entry(nil), f.entries...)
}

// newSchedulerFixture builds a real backup Service over a temp directory, a
// snapshotter and a clock the test controls.
func newSchedulerFixture(t *testing.T, snapshotter *fakeSnapshotter, clock func() time.Time) (*Service, *Scheduler, *fakeBackupAudit, string) {
	t.Helper()
	dir := t.TempDir()
	service, err := NewService(Config{
		Driver:      "sqlite",
		DSN:         "file:test.db",
		Snapshotter: snapshotter,
		BackupDir:   dir,
		AppVersion:  "test",
		Now:         clock,
	})
	require.NoError(t, err)
	recorder := &fakeBackupAudit{}
	scheduler, err := NewScheduler(service, SchedulerOptions{
		Enabled: true,
		Hour:    3,
		Keep:    2,
		Now:     func() time.Time { return time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC) },
		Audit:   recorder,
	})
	require.NoError(t, err)
	return service, scheduler, recorder, dir
}

// TestNextRunIsTheNextCalendarOccurrence covers the schedule computation,
// including the exact boundary instant.
func TestNextRunIsTheNextCalendarOccurrence(t *testing.T) {
	location := time.UTC
	cases := []struct {
		name string
		now  time.Time
		hour int
		want time.Time
	}{
		{
			name: "before the hour fires today",
			now:  time.Date(2026, 11, 17, 1, 0, 0, 0, location),
			hour: 3,
			want: time.Date(2026, 11, 17, 3, 0, 0, 0, location),
		},
		{
			name: "at the hour already fired",
			now:  time.Date(2026, 11, 17, 3, 0, 0, 0, location),
			hour: 3,
			want: time.Date(2026, 11, 18, 3, 0, 0, 0, location),
		},
		{
			name: "after the hour fires tomorrow",
			now:  time.Date(2026, 11, 17, 23, 59, 0, 0, location),
			hour: 3,
			want: time.Date(2026, 11, 18, 3, 0, 0, 0, location),
		},
		{
			name: "midnight is a valid hour",
			now:  time.Date(2026, 11, 17, 0, 30, 0, 0, location),
			hour: 0,
			want: time.Date(2026, 11, 18, 0, 0, 0, 0, location),
		},
		{
			name: "an invalid hour falls back to the documented default",
			now:  time.Date(2026, 11, 17, 1, 0, 0, 0, location),
			hour: 99,
			want: time.Date(2026, 11, 17, DefaultAutoHour, 0, 0, 0, location),
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			require.Equal(t, testCase.want, NextRun(testCase.now, testCase.hour))
		})
	}
}

// TestShouldRunOncePerScheduledInstant proves a restart does not double run and a
// missed occurrence is caught up on the same day.
func TestShouldRunOncePerScheduledInstant(t *testing.T) {
	service, scheduler, _, _ := newSchedulerFixture(t, &fakeSnapshotter{}, testClock(time.Now().UTC()))

	before := time.Date(2026, 11, 17, 2, 0, 0, 0, time.UTC)
	require.False(t, scheduler.shouldRun(before), "before the configured hour nothing runs")

	atHour := time.Date(2026, 11, 17, 3, 0, 0, 0, time.UTC)
	require.True(t, scheduler.shouldRun(atHour), "a fresh process catches up on today's occurrence")

	ranToday := time.Date(2026, 11, 17, 3, 0, 5, 0, time.UTC)
	scheduler.lastRunAt = &ranToday
	require.False(t, scheduler.shouldRun(time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)))
	require.True(t, scheduler.shouldRun(time.Date(2026, 11, 18, 3, 0, 0, 0, time.UTC)),
		"the next day is due again")
	_ = service
}

// testClock returns a clock that advances one minute per call, so three
// consecutive package builds get distinct ids and ordering.
func testClock(start time.Time) func() time.Time {
	current := start
	var mu sync.Mutex
	return func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		value := current
		current = current.Add(time.Minute)
		return value
	}
}

// baseClock is the fixed instant the scheduler itself reports.
func baseClock() time.Time { return time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC) }

// TestPruneKeepsManualBackups is the regression test for retention deleting the
// operator's pre-upgrade package along with the oldest automatic one.
func TestPruneKeepsManualBackups(t *testing.T) {
	service, scheduler, _, _ := newSchedulerFixture(t,
		&fakeSnapshotter{}, testClock(time.Date(2026, 11, 17, 3, 0, 0, 0, time.UTC)))
	scheduler.now = baseClock

	manual, err := service.CreateBackup(context.Background())
	require.NoError(t, err)
	require.Equal(t, OriginManual, manual.Origin)

	for i := 0; i < 3; i++ {
		_, err := scheduler.RunOnce(context.Background())
		require.NoError(t, err)
	}

	// The manual package is older than every automatic one, yet retention must
	// only count and delete the automatic packages.
	require.FileExists(t, filepath.Join(service.BackupDir(), manual.FileName))
	require.FileExists(t, filepath.Join(service.BackupDir(), manual.ID+".meta.json"))

	artifacts, err := service.ListBackups(context.Background(), Actor{Role: site.RolePlatformAdmin})
	require.NoError(t, err)
	require.Len(t, artifacts, 1+2)
}

// TestRunOncePrunesOldArtifacts covers the keep-N retention rule.
func TestRunOncePrunesOldArtifacts(t *testing.T) {
	service, scheduler, recorder, _ := newSchedulerFixture(t,
		&fakeSnapshotter{}, testClock(time.Date(2026, 11, 17, 3, 0, 0, 0, time.UTC)))
	// The scheduler reports a fixed "now"; the service clock advances per run.
	scheduler.now = baseClock

	first, err := scheduler.RunOnce(context.Background())
	require.NoError(t, err)
	second, err := scheduler.RunOnce(context.Background())
	require.NoError(t, err)
	third, err := scheduler.RunOnce(context.Background())
	require.NoError(t, err)

	require.NoFileExists(t, filepath.Join(service.BackupDir(), first.FileName), "the oldest package is pruned")
	require.FileExists(t, filepath.Join(service.BackupDir(), second.FileName))
	require.FileExists(t, filepath.Join(service.BackupDir(), third.FileName))
	require.NoFileExists(t, filepath.Join(service.BackupDir(), first.ID+".meta.json"))

	artifacts, err := service.ListBackups(context.Background(), Actor{Role: site.RolePlatformAdmin})
	require.NoError(t, err)
	require.Len(t, artifacts, 2)

	status := scheduler.Status(context.Background())
	require.True(t, status.Enabled)
	require.Equal(t, 3, status.Hour)
	require.Equal(t, 2, status.Keep)
	require.Equal(t, RunStatusOK, status.LastStatus)
	require.Empty(t, status.LastError)
	require.NotNil(t, status.LastRunAt)
	require.NotNil(t, status.NextRunAt)
	require.Len(t, status.Artifacts, 2)
	require.Equal(t, third.FileName, status.Artifacts[0].Name, "newest first")

	entries := recorder.list()
	require.Len(t, entries, 3)
	last := entries[len(entries)-1]
	require.Equal(t, "backup.auto_run", last.Action)
	require.Equal(t, "success", last.Outcome)
	require.Equal(t, "backup", last.TargetType)
	deleted, ok := last.Detail["deleted"].([]string)
	require.True(t, ok)
	require.Equal(t, []string{first.ID}, deleted)
}

// TestRunOnceRecordsAFailure keeps a broken run observable instead of silent.
func TestRunOnceRecordsAFailure(t *testing.T) {
	snapshotter := &fakeSnapshotter{fail: errors.New("disk full")}
	_, scheduler, recorder, dir := newSchedulerFixture(t, snapshotter, testClock(baseClock()))
	scheduler.now = baseClock

	_, err := scheduler.RunOnce(context.Background())
	require.ErrorContains(t, err, "disk full")

	status := scheduler.Status(context.Background())
	require.Equal(t, RunStatusFailed, status.LastStatus)
	require.Contains(t, status.LastError, "disk full")
	require.Empty(t, status.Artifacts)
	require.NotNil(t, status.LastRunAt)

	entries := recorder.list()
	require.Len(t, entries, 1)
	require.Equal(t, "failure", entries[0].Outcome)
	require.Contains(t, entries[0].Detail["error"].(string), "disk full")

	// A failed run must not leave a half written package behind.
	entriesOnDisk, err := os.ReadDir(dir)
	require.NoError(t, err)
	for _, entry := range entriesOnDisk {
		require.NotContains(t, entry.Name(), ".tmp")
	}
}

// TestRunOnceRefusesAConcurrentRun keeps two loops from writing at once.
func TestRunOnceRefusesAConcurrentRun(t *testing.T) {
	_, scheduler, _, _ := newSchedulerFixture(t, &fakeSnapshotter{}, testClock(baseClock()))
	require.True(t, scheduler.beginRun())
	defer scheduler.endRun()

	_, err := scheduler.RunOnce(context.Background())
	require.ErrorIs(t, err, ErrSchedulerBusy)
}

// TestCheckCatchesUpOnlyOncePerDay proves the loop's decision is idempotent.
func TestCheckCatchesUpOnlyOncePerDay(t *testing.T) {
	service, scheduler, _, _ := newSchedulerFixture(t, &fakeSnapshotter{}, testClock(baseClock()))
	scheduler.now = baseClock

	scheduler.check(context.Background())
	scheduler.check(context.Background())

	artifacts, err := service.ListBackups(context.Background(), Actor{Role: site.RolePlatformAdmin})
	require.NoError(t, err)
	require.Len(t, artifacts, 1)
}

// TestEnvSchedulerOptions covers defaults, overrides and rejection.
func TestEnvSchedulerOptions(t *testing.T) {
	t.Run("defaults", func(t *testing.T) {
		t.Setenv(EnvAutoEnabled, "")
		t.Setenv(EnvAutoHour, "")
		t.Setenv(EnvAutoKeep, "")
		options, err := EnvSchedulerOptions()
		require.NoError(t, err)
		require.False(t, options.Enabled, "automatic backups are off unless enabled")
		require.Equal(t, DefaultAutoHour, options.Hour)
		require.Equal(t, DefaultAutoKeep, options.Keep)
	})

	t.Run("explicit values", func(t *testing.T) {
		t.Setenv(EnvAutoEnabled, "true")
		t.Setenv(EnvAutoHour, "22")
		t.Setenv(EnvAutoKeep, "14")
		options, err := EnvSchedulerOptions()
		require.NoError(t, err)
		require.True(t, options.Enabled)
		require.Equal(t, 22, options.Hour)
		require.Equal(t, 14, options.Keep)
	})

	for _, testCase := range []struct{ name, key, value string }{
		{name: "enabled", key: EnvAutoEnabled, value: "maybe"},
		{name: "hour", key: EnvAutoHour, value: "24"},
		{name: "hour text", key: EnvAutoHour, value: "three"},
		{name: "keep", key: EnvAutoKeep, value: "0"},
	} {
		t.Run("invalid "+testCase.name, func(t *testing.T) {
			t.Setenv(EnvAutoEnabled, "")
			t.Setenv(EnvAutoHour, "")
			t.Setenv(EnvAutoKeep, "")
			t.Setenv(testCase.key, testCase.value)
			_, err := EnvSchedulerOptions()
			require.ErrorIs(t, err, ErrInvalidInput)
		})
	}
}

// TestNewSchedulerValidatesOptions keeps a hand built scheduler honest.
func TestNewSchedulerValidatesOptions(t *testing.T) {
	service, err := NewService(Config{
		Driver: "sqlite", DSN: "file:test.db", BackupDir: t.TempDir(),
		Snapshotter: &fakeSnapshotter{}, AppVersion: "test",
	})
	require.NoError(t, err)

	_, err = NewScheduler(nil, SchedulerOptions{})
	require.ErrorIs(t, err, ErrInvalidInput)
	_, err = NewScheduler(service, SchedulerOptions{Hour: 24})
	require.ErrorIs(t, err, ErrInvalidInput)
}

// scheduleEngine mounts the schedule handler the way the router does.
func scheduleEngine(t *testing.T, scheduler *Scheduler) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(ginmiddleware.ErrorHandler(nil))
	handler := NewScheduleHandler(scheduler, ScheduleHandlerConfig{
		Principal: func(c *gin.Context) (Actor, bool) {
			role := c.GetHeader("X-Test-Role")
			if role == "" {
				return Actor{}, false
			}
			return Actor{UserID: "admin", Role: site.Role(role)}, true
		},
	})
	noop := func(c *gin.Context) { c.Next() }
	handler.Routes(engine.Group("/api/v1"), noop)
	return engine
}

// TestScheduleHandlerAuthorisationAndShape covers 401/403/200 and the payload.
func TestScheduleHandlerAuthorisationAndShape(t *testing.T) {
	_, scheduler, _, _ := newSchedulerFixture(t, &fakeSnapshotter{}, testClock(baseClock()))
	scheduler.now = baseClock
	engine := scheduleEngine(t, scheduler)

	request := func(role string) *httptest.ResponseRecorder {
		httpRequest := httptest.NewRequest(http.MethodGet, "/api/v1/system/backup-schedule", nil)
		if role != "" {
			httpRequest.Header.Set("X-Test-Role", role)
		}
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, httpRequest)
		return response
	}

	require.Equal(t, http.StatusUnauthorized, request("").Code)
	siteAdmin := request(string(site.RoleSiteAdmin))
	require.Equal(t, http.StatusForbidden, siteAdmin.Code)
	require.Contains(t, siteAdmin.Body.String(), `"reason":"platform_admin_required"`)

	platform := request(string(site.RolePlatformAdmin))
	require.Equal(t, http.StatusOK, platform.Code)
	require.Equal(t, "no-store", platform.Header().Get("Cache-Control"))

	var body struct {
		Enabled    bool               `json:"enabled"`
		Hour       int                `json:"hour"`
		Keep       int                `json:"keep"`
		NextRunAt  *time.Time         `json:"next_run_at"`
		Artifacts  []ScheduleArtifact `json:"artifacts"`
		LastStatus string             `json:"last_status"`
	}
	require.NoError(t, json.Unmarshal(platform.Body.Bytes(), &body))
	require.True(t, body.Enabled)
	require.Equal(t, 3, body.Hour)
	require.Equal(t, 2, body.Keep)
	require.NotNil(t, body.NextRunAt)
	require.NotNil(t, body.Artifacts, "artifacts is an array, never null")
	require.Empty(t, body.LastStatus, "no run has happened yet")
}

// TestScheduleHandlerDisabledOmitsNextRun keeps the disabled state truthful.
func TestScheduleHandlerDisabledOmitsNextRun(t *testing.T) {
	service, err := NewService(Config{
		Driver: "sqlite", DSN: "file:test.db", BackupDir: t.TempDir(),
		Snapshotter: &fakeSnapshotter{}, AppVersion: "test",
	})
	require.NoError(t, err)
	scheduler, err := NewScheduler(service, SchedulerOptions{Enabled: false, Hour: 3, Keep: 7})
	require.NoError(t, err)

	status := scheduler.Status(context.Background())
	require.False(t, status.Enabled)
	require.Nil(t, status.NextRunAt)
	require.NotNil(t, status.Artifacts)
}
