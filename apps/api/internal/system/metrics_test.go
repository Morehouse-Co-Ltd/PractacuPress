package system

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

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
		"practacu-api":      "api",
		"practacu-security": "security",
		"practacupress":     "launcher",
	})
	dirs := []string{`C:\Users\owner\Practacu Press`}

	cases := []struct {
		name    string
		exe     string
		cmdline string
		want    string
	}{
		{"practacu-api.exe", `C:\Users\owner\Practacu Press\data\practacu-api.exe`, "", "api"},
		{"practacu-security.exe", `C:\Users\owner\Practacu Press\services\security\practacu-security.exe`, "", "security"},
		{"PractacuPress.exe", `C:\Users\owner\Practacu Press\PractacuPress.exe`, "", "launcher"},
		{"node.exe", `C:\Program Files\nodejs\node.exe`, `node "C:\Users\owner\Practacu Press\apps\web\node_modules\vite\bin\vite.js"`, "web"},
		{"esbuild.exe", `C:\Users\owner\AppData\Local\npm-cache\esbuild.exe`, `esbuild --service --cwd C:\Users\owner\Practacu Press\apps\web`, "app"},
		// A terminal or automation host that merely mentions the directory is not us.
		{"DeepSeek Harness.exe", `C:\Users\owner\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`, `runner.js -- powershell -Command "Set-Location 'C:\Users\owner\Practacu Press'; npm run dev"`, ""},
		{"helper.exe", `C:\Users\owner\Practacu Press\tools\helper.exe`, "", "app"},
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
