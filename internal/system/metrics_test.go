package system

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/shirou/gopsutil/v4/process"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
)

func TestDefaultAppNamesCoversBuildSpellings(t *testing.T) {
	names := normalizeAppNames(DefaultAppNames())
	want := map[string]string{
		"practacu-api":     "api", // scripts/dev.ps1
		"practacupressapi": "api", // packaged PractacuPressAPI.exe
		"practacupress":    "launcher",
	}
	for exe, role := range want {
		if got := names[exe]; got != role {
			t.Fatalf("DefaultAppNames()[%q] = %q, want %q", exe, got, role)
		}
	}
}

func TestCurrentProcessIsAPI(t *testing.T) {
	sampler := NewSampler(SamplerConfig{
		AppNames: map[string]string{"practacu-api": "api"},
		// Even when the test binary happens to live under an install directory, the
		// pid check must win: the running API is always the "api" role.
		AppDirs: []string{repoRootForTest()},
	})
	self, err := process.NewProcess(int32(os.Getpid()))
	if err != nil {
		t.Fatalf("open current process: %v", err)
	}
	// "server.exe" is what a plain `go build` produces; it is not a known app name.
	if got := sampler.roleOf(self, "server.exe"); got != "api" {
		t.Fatalf("role of current process = %q, want api", got)
	}
	if got := sampler.roleOf(self, "practacu-api.exe"); got != "api" {
		t.Fatalf("role of current process with known name = %q, want api", got)
	}
}

func TestSampleOnceAttributesCurrentProcess(t *testing.T) {
	if testing.Short() {
		t.Skip("samples the real process table")
	}
	sampler := NewSampler(SamplerConfig{})
	// Two samples: the first one primes the per-process CPU baseline.
	sampler.sampleOnce()
	sampler.sampleOnce()
	snapshot := sampler.Latest()
	self := int32(os.Getpid())
	found := false
	for _, sample := range snapshot.App.Processes {
		if sample.PID != self {
			continue
		}
		found = true
		if sample.Role != "api" {
			t.Fatalf("current process role = %q, want api", sample.Role)
		}
	}
	if !found {
		t.Fatalf("current process %d missing from app processes %+v", self, snapshot.App.Processes)
	}
	if snapshot.Others.ProcessCount == 0 {
		t.Fatal("expected other processes to be counted")
	}
	if snapshot.App.CPUPercent > snapshot.CPU.UsagePercent {
		t.Fatalf("app cpu %v exceeds host cpu %v", snapshot.App.CPUPercent, snapshot.CPU.UsagePercent)
	}
	if snapshot.App.MemoryBytes > snapshot.Memory.UsedBytes && snapshot.Memory.UsedBytes > 0 {
		t.Fatalf("app memory %d exceeds used memory %d", snapshot.App.MemoryBytes, snapshot.Memory.UsedBytes)
	}
}

func TestAggregateProcessesAttribution(t *testing.T) {
	procs := []sampledProcess{
		// Windows idle pseudo process: must be ignored everywhere.
		{pid: 0, name: "System Idle Process", cpuPercent: 80, memoryBytes: 1 << 30},
		{pid: 100, name: "PractacuPressAPI.exe", role: "api", cpuPercent: 1.5, memoryBytes: 100},
		{pid: 101, name: "node.exe", role: "web", cpuPercent: 2.0, memoryBytes: 200},
		{pid: 200, name: "chrome.exe", cpuPercent: 3.0, memoryBytes: 300},
		{pid: 201, name: "chrome.exe", cpuPercent: 4.0, memoryBytes: 400},
		{pid: 300, name: "code.exe", cpuPercent: 5.0, memoryBytes: 500},
	}
	app, others := aggregateProcesses(procs, 12.5, 2000)

	if len(app.processes) != 2 {
		t.Fatalf("app processes = %+v", app.processes)
	}
	// Sorted by memory: the bigger process comes first, roles stay distinguishable.
	if app.processes[0].Role != "web" || app.processes[1].Role != "api" {
		t.Fatalf("roles = %+v", app.processes)
	}
	if app.cpuPercent != 3.5 {
		t.Fatalf("app cpu = %v, want 3.5", app.cpuPercent)
	}
	if app.memoryBytes != 300 {
		t.Fatalf("app memory = %d, want 300", app.memoryBytes)
	}
	// Unknown processes are folded by executable name.
	if others.ProcessCount != 3 {
		t.Fatalf("other process count = %d, want 3", others.ProcessCount)
	}
	if others.CPUPercent != 9 {
		t.Fatalf("other cpu = %v, want 9", others.CPUPercent)
	}
	if others.MemoryBytes != 1700 {
		t.Fatalf("other memory = %d, want 1700", others.MemoryBytes)
	}
	if len(others.TopProcesses) != 2 {
		t.Fatalf("top others = %+v", others.TopProcesses)
	}
	chrome := others.TopProcesses[0]
	if chrome.Name != "chrome.exe" || chrome.Processes != 2 || chrome.CPUPercent != 7 || chrome.MemoryBytes != 700 {
		t.Fatalf("chrome aggregate = %+v", chrome)
	}
	// app + others == host totals, never overlapping.
	if app.cpuPercent+others.CPUPercent != 12.5 {
		t.Fatalf("shares do not add up: %v + %v", app.cpuPercent, others.CPUPercent)
	}
	if app.memoryBytes+others.MemoryBytes != 2000 {
		t.Fatalf("memory shares do not add up: %d + %d", app.memoryBytes, others.MemoryBytes)
	}
}

func TestAggregateProcessesClampsToHostTotals(t *testing.T) {
	procs := []sampledProcess{
		{pid: 10, name: "server", role: "api", cpuPercent: 90, memoryBytes: 5000},
		{pid: 20, name: "chrome.exe", cpuPercent: -5, memoryBytes: 100},
	}
	app, others := aggregateProcesses(procs, 10, 1000)
	if app.cpuPercent != 10 {
		t.Fatalf("app cpu = %v, want clamped to host 10", app.cpuPercent)
	}
	if others.CPUPercent != 0 {
		t.Fatalf("other cpu = %v, want 0 (never negative)", others.CPUPercent)
	}
	if app.memoryBytes != 1000 {
		t.Fatalf("app memory = %d, want clamped to used 1000", app.memoryBytes)
	}
	if others.MemoryBytes != 0 {
		t.Fatalf("other memory = %d, want 0", others.MemoryBytes)
	}
	// A negative process reading is clamped instead of reducing the host total.
	if len(others.TopProcesses) != 1 || others.TopProcesses[0].CPUPercent != 0 {
		t.Fatalf("top others = %+v", others.TopProcesses)
	}
}

func TestProcessCPUPercent(t *testing.T) {
	cases := []struct {
		delta  float64
		window float64
		cores  int
		want   float64
	}{
		{1, 2, 4, 12.5},
		{2, 2, 4, 25},
		{100, 1, 1, 100},
		{0, 2, 4, 0},
		{-3, 2, 4, 0},
		{math.NaN(), 2, 4, 0},
		{1, 0, 4, 0},
		{1, math.Inf(1), 4, 0},
		{1, 1, 0, 100}, // a bad core count falls back to one core
	}
	for _, tc := range cases {
		if got := processCPUPercent(tc.delta, tc.window, tc.cores); got != tc.want {
			t.Fatalf("processCPUPercent(%v, %v, %d) = %v, want %v", tc.delta, tc.window, tc.cores, got, tc.want)
		}
	}
}

func TestSampleWindowUsesRealElapsedOnlyWhenPositive(t *testing.T) {
	base := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	if got := sampleWindow(base.Add(60*time.Second), base, 2*time.Second); got != 60 {
		t.Fatalf("delayed window = %v, want the real 60s", got)
	}
	if got := sampleWindow(base, base, 2*time.Second); got != 2 {
		t.Fatalf("zero window = %v, want fallback 2", got)
	}
	if got := sampleWindow(base.Add(-time.Second), base, 2*time.Second); got != 2 {
		t.Fatalf("backwards window = %v, want fallback 2", got)
	}
	if got := sampleWindow(base, base, 0); got != DefaultInterval.Seconds() {
		t.Fatalf("missing fallback = %v, want default interval", got)
	}
}

func TestNewMemoryUsage(t *testing.T) {
	usage := newMemoryUsage(100, 40)
	if usage.UsedBytes != 60 || usage.FreeBytes != 40 || usage.UsagePercent != 60 {
		t.Fatalf("usage = %+v", usage)
	}
	// A driver reporting more available than total must not yield a negative used.
	over := newMemoryUsage(100, 140)
	if over.UsedBytes != 0 || over.FreeBytes != 100 || over.UsagePercent != 0 {
		t.Fatalf("over-reported available = %+v", over)
	}
	empty := newMemoryUsage(0, 0)
	if empty.UsedBytes != 0 || empty.UsagePercent != 0 {
		t.Fatalf("empty = %+v", empty)
	}
}

func TestNormalizeProcessName(t *testing.T) {
	cases := map[string]string{
		"PractacuPress.exe": "practacupress",
		"practacu-api.EXE":  "practacu-api",
		"node":              "node",
		"  Report.exe  ":    "report",
		"":                  "",
	}
	for input, want := range cases {
		if got := normalizeProcessName(input); got != want {
			t.Fatalf("normalizeProcessName(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestClassifyProcess(t *testing.T) {
	names := normalizeAppNames(map[string]string{
		"practacu-api":  "api",
		"practacupress": "launcher",
	})
	// Both spellings are always configured, and the same cases are asserted on every
	// platform: the classification must not depend on the host that runs the test.
	dirs := []string{`C:\Users\owner\Practacu Press`, "/opt/practacu/app"}

	cases := []struct {
		name    string
		exe     string
		cmdline string
		want    string
	}{
		{"practacu-api.exe", `C:\Users\owner\Practacu Press\data\practacu-api.exe`, "", "api"},
		{"PractacuPress.exe", `C:\Users\owner\Practacu Press\PractacuPress.exe`, "", "launcher"},
		{"node.exe", `C:\Program Files\nodejs\node.exe`, `node "C:\Users\owner\Practacu Press\web\node_modules\vite\bin\vite.js"`, "web"},
		{"esbuild.exe", `C:\Users\owner\AppData\Local\npm-cache\esbuild.exe`, `esbuild --service --cwd C:\Users\owner\Practacu Press\web`, "app"},
		// A terminal or automation host that merely mentions the directory is not us.
		{"DeepSeek Harness.exe", `C:\Users\owner\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`, `runner.js -- powershell -Command "Set-Location 'C:\Users\owner\Practacu Press'; npm run dev"`, ""},
		{"helper.exe", `C:\Users\owner\Practacu Press\tools\helper.exe`, "", "app"},
		{"helper.exe", `C:/Users/owner/Practacu Press/tools/helper.exe`, "", "app"},
		// POSIX-style paths and directories must classify exactly like Windows ones.
		{"helper", "/opt/practacu/app/tools/helper", "", "app"},
		{"helper", "/opt/practacu/app", "", "app"},
		{"helper", "/usr/local/bin/helper", "", ""},
		// A sibling whose name merely starts with the directory is not inside it.
		{"helper", "/opt/practacu/application/tools/helper", "", ""},
		{"chrome.exe", `C:\Program Files\Google\Chrome\chrome.exe`, `chrome --type=renderer`, ""},
		{"", "", "", ""},
	}
	for _, tc := range cases {
		if got := classifyProcess(tc.name, tc.exe, tc.cmdline, names, dirs); got != tc.want {
			t.Fatalf("classifyProcess(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestTopOtherProcessesFoldsAndSorts(t *testing.T) {
	byName := map[string]*AggregateProcess{
		"chrome":  {Name: "chrome", Processes: 20, CPUPercent: 12.345, MemoryBytes: 900},
		"code":    {Name: "code", Processes: 6, CPUPercent: 3.2, MemoryBytes: 1500},
		"svchost": {Name: "svchost", Processes: 40, CPUPercent: 1.1, MemoryBytes: 300},
	}
	top := topOtherProcesses(byName, 2)
	if len(top) != 2 {
		t.Fatalf("got %d rows, want 2", len(top))
	}
	if top[0].Name != "code" || top[1].Name != "chrome" {
		t.Fatalf("unexpected order: %+v", top)
	}
	if top[0].CPUPercent != 3.2 {
		t.Fatalf("cpu rounding = %v", top[0].CPUPercent)
	}
}

func TestMeasureStorage(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	mediaDir := filepath.Join(dataDir, "media")
	backupDir := filepath.Join(dataDir, "backups")
	for _, dir := range []string{mediaDir, backupDir, filepath.Join(dataDir, "logs")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path string, size int) {
		if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(dataDir, "practacu.db"), 1000)
	write(filepath.Join(mediaDir, "a.png"), 2000)
	write(filepath.Join(backupDir, "b.zip"), 3000)
	write(filepath.Join(dataDir, "logs", "api.log"), 500)

	footprint := measureStorage(dataDir, mediaDir, backupDir)
	if footprint.DataDir != dataDir {
		t.Fatalf("data dir = %q", footprint.DataDir)
	}
	if footprint.DatabaseBytes != 1000 {
		t.Fatalf("database = %d", footprint.DatabaseBytes)
	}
	if footprint.MediaBytes != 2000 {
		t.Fatalf("media = %d", footprint.MediaBytes)
	}
	if footprint.BackupBytes != 3000 {
		t.Fatalf("backup = %d", footprint.BackupBytes)
	}
	if footprint.TotalBytes != 6500 {
		t.Fatalf("total = %d", footprint.TotalBytes)
	}
	if footprint.OtherBytes != 500 {
		t.Fatalf("other = %d", footprint.OtherBytes)
	}
}

func TestMeasureStorageDisjointRoots(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	mediaDir := filepath.Join(root, "media-outside")
	backupDir := filepath.Join(root, "backups-outside")
	for _, dir := range []string{dataDir, mediaDir, backupDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path string, size int) {
		if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(dataDir, "practacu.db"), 100)
	write(filepath.Join(dataDir, "practacu.db-wal"), 20)
	write(filepath.Join(dataDir, "api.log"), 30)
	write(filepath.Join(mediaDir, "a.png"), 200)
	write(filepath.Join(backupDir, "b.zip"), 300)

	footprint := measureStorage(dataDir, mediaDir, backupDir)
	if footprint.DatabaseBytes != 120 {
		t.Fatalf("database = %d, want 120 (db + wal)", footprint.DatabaseBytes)
	}
	if footprint.MediaBytes != 200 {
		t.Fatalf("media = %d, want 200", footprint.MediaBytes)
	}
	if footprint.BackupBytes != 300 {
		t.Fatalf("backup = %d, want 300", footprint.BackupBytes)
	}
	if footprint.OtherBytes != 30 {
		t.Fatalf("other = %d, want 30", footprint.OtherBytes)
	}
	if footprint.TotalBytes != 650 {
		t.Fatalf("total = %d, want 650", footprint.TotalBytes)
	}
	// The four buckets are disjoint by construction; the panel bar depends on it.
	sum := footprint.DatabaseBytes + footprint.MediaBytes + footprint.BackupBytes + footprint.OtherBytes
	if sum != footprint.TotalBytes {
		t.Fatalf("buckets sum to %d, total is %d", sum, footprint.TotalBytes)
	}
}

func TestWithinDir(t *testing.T) {
	root := t.TempDir()
	if !withinDir(filepath.Join(root, "a"), root) {
		t.Fatal("child should be within parent")
	}
	if withinDir(filepath.Join(root, "..", "elsewhere"), root) {
		t.Fatal("sibling should not be within parent")
	}
}

func TestClampPercent(t *testing.T) {
	if got := clampPercent(-3); got != 0 {
		t.Fatalf("negative = %v", got)
	}
	if got := clampPercent(140); got != 100 {
		t.Fatalf("over 100 = %v", got)
	}
	if got := clampPercent(12.345); got != 12.35 {
		t.Fatalf("rounding = %v", got)
	}
	// NaN and infinities come from drivers or damaged counters; they must never leak
	// a NaN or a huge negative value into the JSON payload.
	if got := clampPercent(math.NaN()); got != 0 {
		t.Fatalf("NaN = %v", got)
	}
	if got := clampPercent(math.Inf(1)); got != 100 {
		t.Fatalf("+Inf = %v", got)
	}
	if got := clampPercent(math.Inf(-1)); got != 0 {
		t.Fatalf("-Inf = %v", got)
	}
}

// repoRootForTest walks up from the package directory to the module root.
func repoRootForTest() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for depth := 0; depth < 8; depth += 1 {
		if _, statErr := os.Stat(filepath.Join(dir, "go.mod")); statErr == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

func newTestRouter(latest func() Snapshot, principal PrincipalFunc) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	// The production router translates c.Error into problem JSON. The tests mount the
	// same translation in miniature so a 401/403 assertion matches the wire behaviour.
	router.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) == 0 {
			return
		}
		if problem, ok := c.Errors.Last().Err.(*apperr.Problem); ok {
			c.AbortWithStatusJSON(problem.Status, problem)
			return
		}
		c.AbortWithStatus(http.StatusInternalServerError)
	})
	handler := NewHandler(latest, HandlerConfig{Principal: principal})
	handler.Routes(router.Group("/api/v1"), func(c *gin.Context) { c.Next() })
	return router
}

func TestMetricsRequiresPlatformAdmin(t *testing.T) {
	snapshotAt := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	snapshot := Snapshot{SampledAt: snapshotAt, CPU: CPUUsage{UsagePercent: 12.5}}

	router := newTestRouter(
		func() Snapshot { return snapshot },
		func(*gin.Context) (string, bool) { return "site_admin", true },
	)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/system/metrics", nil)
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	if body := recorder.Body.String(); !containsAll(body, "permission_denied", "platform_admin_required") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestMetricsRejectsAnonymous(t *testing.T) {
	router := newTestRouter(
		func() Snapshot { return Snapshot{} },
		func(*gin.Context) (string, bool) { return "", false },
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/system/metrics", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestMetricsServesSnapshot(t *testing.T) {
	snapshotAt := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	snapshot := Snapshot{
		SampledAt: snapshotAt,
		CPU:       CPUUsage{UsagePercent: 12.5, Cores: 8},
		App: AppUsage{
			Processes:  []ProcessSample{{PID: 10, Name: "practacu-api", Role: "api", CPUPercent: 1, MemoryBytes: 2048}},
			CPUPercent: 1,
		},
		Others: OtherUsage{
			TopProcesses: []AggregateProcess{{Name: "chrome", Processes: 3, CPUPercent: 5, MemoryBytes: 4096}},
		},
	}
	router := newTestRouter(
		func() Snapshot { return snapshot },
		func(*gin.Context) (string, bool) { return "platform_admin", true },
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/system/metrics", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	if cache := recorder.Header().Get("Cache-Control"); cache != "no-store" {
		t.Fatalf("cache control = %q", cache)
	}
	var payload Snapshot
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.SampledAt.Equal(snapshotAt) {
		t.Fatalf("sampled_at = %s", payload.SampledAt)
	}
	if len(payload.App.Processes) != 1 || payload.App.Processes[0].Role != "api" {
		t.Fatalf("unexpected app processes: %+v", payload.App.Processes)
	}
	if len(payload.Others.TopProcesses) != 1 {
		t.Fatalf("unexpected others: %+v", payload.Others.TopProcesses)
	}
}

func containsAll(haystack string, needles ...string) bool {
	for _, needle := range needles {
		if !contains(haystack, needle) {
			return false
		}
	}
	return true
}

func contains(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
