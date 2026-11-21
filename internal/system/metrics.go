// Package system reports live resource usage of the host and of this installation.
//
// The admin "performance panel" is an optional add-on module: it is wired only when
// the composition root constructs a Handler, and its whole server side lives in this
// package. Nothing else in the API depends on gopsutil or on this package.
//
// Trust model: the snapshot exposes host names, process names and storage paths, so
// the endpoint is restricted to platform administrators. It is read-only and cached:
// a background sampler wakes every few seconds and every HTTP request serves the last
// sample, which keeps the panel cheap no matter how often the browser polls.
package system

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/process"
)

// DefaultInterval is how often the background sampler refreshes the snapshot.
const DefaultInterval = 2 * time.Second

// storageRescanInterval throttles the (potentially large) directory walk.
const storageRescanInterval = 60 * time.Second

// ProcessSample is one process owned by this installation.
type ProcessSample struct {
	PID         int32   `json:"pid"`
	Name        string  `json:"name"`
	Role        string  `json:"role"`
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryBytes uint64  `json:"memory_bytes"`
}

// AggregateProcess folds every process of the same executable into one row, so a
// browser with fifty content processes does not fill the "other software" table.
type AggregateProcess struct {
	Name        string  `json:"name"`
	Processes   int     `json:"processes"`
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryBytes uint64  `json:"memory_bytes"`
}

// StorageFootprint is how much disk this installation itself uses.
type StorageFootprint struct {
	DataDir       string `json:"data_dir"`
	TotalBytes    uint64 `json:"total_bytes"`
	DatabaseBytes uint64 `json:"database_bytes"`
	MediaBytes    uint64 `json:"media_bytes"`
	BackupBytes   uint64 `json:"backup_bytes"`
	OtherBytes    uint64 `json:"other_bytes"`
}

// PlatformInfo is static host identity plus uptime.
type PlatformInfo struct {
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	Hostname      string `json:"hostname"`
	UptimeSeconds uint64 `json:"uptime_seconds"`
}

// CPUUsage is host level CPU usage across all cores.
type CPUUsage struct {
	UsagePercent float64 `json:"usage_percent"`
	Cores        int     `json:"cores"`
	Model        string  `json:"model"`
}

// MemoryUsage is host level physical memory usage.
type MemoryUsage struct {
	TotalBytes   uint64  `json:"total_bytes"`
	UsedBytes    uint64  `json:"used_bytes"`
	FreeBytes    uint64  `json:"free_bytes"`
	UsagePercent float64 `json:"usage_percent"`
}

// DiskUsage is the filesystem that holds this installation's data.
type DiskUsage struct {
	Path         string  `json:"path"`
	TotalBytes   uint64  `json:"total_bytes"`
	UsedBytes    uint64  `json:"used_bytes"`
	FreeBytes    uint64  `json:"free_bytes"`
	UsagePercent float64 `json:"usage_percent"`
}

// AppUsage is everything attributed to this installation.
type AppUsage struct {
	Processes   []ProcessSample  `json:"processes"`
	CPUPercent  float64          `json:"cpu_percent"`
	MemoryBytes uint64           `json:"memory_bytes"`
	Storage     StorageFootprint `json:"storage"`
	// UptimeSeconds is how long this API process has been running.
	UptimeSeconds uint64 `json:"uptime_seconds"`
	// TotalUptimeSeconds is the accumulated running time across restarts, including
	// the current session. It comes from UptimeTracker, which persists to
	// <data>/runtime/uptime.json; zero means the tracker is not configured.
	TotalUptimeSeconds uint64 `json:"total_uptime_seconds"`
}

// OtherUsage is everything attributed to the rest of the machine.
type OtherUsage struct {
	CPUPercent   float64            `json:"cpu_percent"`
	MemoryBytes  uint64             `json:"memory_bytes"`
	ProcessCount int                `json:"process_count"` // processes not attributed to this software
	TopProcesses []AggregateProcess `json:"top_processes"`
}

// Snapshot is the immutable payload served to the panel.
type Snapshot struct {
	SampledAt time.Time    `json:"sampled_at"`
	Platform  PlatformInfo `json:"platform"`
	CPU       CPUUsage     `json:"cpu"`
	Memory    MemoryUsage  `json:"memory"`
	Disk      DiskUsage    `json:"disk"`
	App       AppUsage     `json:"app"`
	Others    OtherUsage   `json:"others"`
}

// SamplerConfig configures a Sampler.
type SamplerConfig struct {
	// Interval between samples; zero means DefaultInterval.
	Interval time.Duration
	// AppNames maps a normalized executable base name (lower case, no .exe) to the
	// role shown in the panel, for example {"practacu-api": "api"}.
	AppNames map[string]string
	// AppDirs are directories that identify this installation. A process whose
	// executable or command line lives under one of them is attributed to the app
	// even when its executable name is generic (node running the Vite dev server).
	AppDirs []string
	// DataDir is the installation's data directory (database, media, backups).
	DataDir string
	// MediaDir and BackupDir are measured separately inside DataDir.
	MediaDir  string
	BackupDir string
	// Uptime, when set, adds the software's session and accumulated running time to
	// every sample. It is optional so tests and embedders can sample without a state
	// file.
	Uptime *UptimeTracker
}

// DefaultAppNames returns the executable names this installation ships.
//
// The API binary is built under different names depending on how the installation
// runs: the packaged release ships PractacuPressAPI.exe, and a plain `go build` may
// leave server.exe. The current process is additionally recognised by pid (see
// roleOf) so every spelling is attributed to "api" instead of falling through to
// "app".
func DefaultAppNames() map[string]string {
	return map[string]string{
		"practacu-api":     "api",
		"practacupressapi": "api",
	}
}

// Sampler refreshes a Snapshot in the background.
type Sampler struct {
	cfg SamplerConfig

	mu       sync.RWMutex
	snapshot Snapshot

	prev   map[int32]processCPU
	prevAt time.Time

	staticOnce sync.Once
	static     staticInfo

	storageMu sync.Mutex
	storage   StorageFootprint
	storageAt time.Time
}

type processCPU struct {
	name        string
	role        string
	seconds     float64
	hasSeconds  bool
	memoryBytes uint64
}

type staticInfo struct {
	hostname string
	cpuModel string
	cores    int
}

// NewSampler builds a sampler. Call Start to begin sampling.
func NewSampler(cfg SamplerConfig) *Sampler {
	if cfg.Interval <= 0 {
		cfg.Interval = DefaultInterval
	}
	if len(cfg.AppNames) == 0 {
		cfg.AppNames = DefaultAppNames()
	}
	cfg.AppNames = normalizeAppNames(cfg.AppNames)
	cfg.AppDirs = normalizeDirs(cfg.AppDirs)
	cfg.DataDir = resolvePath(cfg.DataDir)
	cfg.MediaDir = resolvePath(cfg.MediaDir)
	cfg.BackupDir = resolvePath(cfg.BackupDir)
	if cfg.DataDir == "" {
		cfg.DataDir = cfg.MediaDir
	}
	return &Sampler{cfg: cfg, prev: map[int32]processCPU{}}
}

// Start launches the background loop until ctx is cancelled.
func (s *Sampler) Start(ctx context.Context) {
	// Prime the global CPU counter so the first real sample is a short window, and
	// warm the process baseline so per-process percentages are meaningful.
	_, _ = cpu.Percent(0, false)
	// 启动时先落一次盘：状态文件在第一次采样前就存在，便于排查「有没有在记」，
	// 也保证后面 60 秒的写入节奏从启动时刻算起。
	if s.cfg.Uptime != nil {
		_ = s.cfg.Uptime.Flush()
	}
	s.sampleOnce()
	go func() {
		// 优雅退出前补一次落盘：崩溃最多丢一个 flush 间隔，正常停止不丢。
		defer func() {
			if s.cfg.Uptime != nil {
				_ = s.cfg.Uptime.Flush()
			}
		}()
		ticker := time.NewTicker(s.cfg.Interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.sampleOnce()
			}
		}
	}()
}

// Latest returns the most recent snapshot. It never blocks on collection.
func (s *Sampler) Latest() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	snapshot := s.snapshot
	// Copy the slices so the caller cannot mutate the cached snapshot.
	snapshot.App.Processes = append([]ProcessSample(nil), s.snapshot.App.Processes...)
	snapshot.Others.TopProcesses = append([]AggregateProcess(nil), s.snapshot.Others.TopProcesses...)
	return snapshot
}

func (s *Sampler) sampleOnce() {
	now := time.Now()
	static := s.loadStatic()

	hostCPU := 0.0
	if values, err := cpu.Percent(0, false); err == nil && len(values) > 0 {
		hostCPU = clampPercent(values[0])
	}

	memory := MemoryUsage{}
	if vm, err := mem.VirtualMemory(); err == nil && vm != nil {
		memory = newMemoryUsage(vm.Total, vm.Available)
	}

	diskUsage := DiskUsage{}
	diskPath := s.cfg.DataDir
	if diskPath == "" {
		diskPath = "."
	}
	if usage, err := disk.Usage(diskPath); err == nil && usage != nil {
		diskUsage = DiskUsage{
			Path:         diskPath,
			TotalBytes:   usage.Total,
			UsedBytes:    usage.Used,
			FreeBytes:    usage.Free,
			UsagePercent: clampPercent(usage.UsedPercent),
		}
	}

	app, others := aggregateProcesses(s.sampleProcesses(now, static.cores), hostCPU, memory.UsedBytes)

	// 运行时长随每个样本一起刷新：Observe 负责按 60 秒的节奏落盘，
	// Totals 给出「本次启动 / 跨启停累计」两个秒数。
	var sessionUptime, totalUptime uint64
	if s.cfg.Uptime != nil {
		s.cfg.Uptime.Observe()
		sessionUptime, totalUptime = s.cfg.Uptime.Totals()
	}

	snapshot := Snapshot{
		SampledAt: now.UTC(),
		Platform: PlatformInfo{
			OS:            runtime.GOOS,
			Arch:          runtime.GOARCH,
			Hostname:      static.hostname,
			UptimeSeconds: hostUptime(),
		},
		CPU: CPUUsage{
			UsagePercent: hostCPU,
			Cores:        static.cores,
			Model:        static.cpuModel,
		},
		Memory: memory,
		Disk:   diskUsage,
		App: AppUsage{
			Processes:          app.processes,
			CPUPercent:         app.cpuPercent,
			MemoryBytes:        app.memoryBytes,
			Storage:            s.storageFootprint(now),
			UptimeSeconds:      sessionUptime,
			TotalUptimeSeconds: totalUptime,
		},
		Others: others,
	}

	s.mu.Lock()
	s.snapshot = snapshot
	s.mu.Unlock()
}

// aggregatedUsage is the "this software" side of one sample.
type aggregatedUsage struct {
	processes   []ProcessSample
	cpuPercent  float64
	memoryBytes uint64
}

// aggregateProcesses folds the per-process samples into the two tables the panel
// shows. It is pure (no OS access) so the accounting rules can be tested without
// sampling the real machine:
//
//   - the host idle pseudo process is ignored;
//   - processes attributed to this installation are listed individually;
//   - every other process is aggregated by executable name and counted as "others";
//   - app + others are clamped to the host figures, so neither can go negative and
//     the two shares always add up to the host total instead of overlapping.
func aggregateProcesses(procs []sampledProcess, hostCPU float64, hostUsedMemory uint64) (aggregatedUsage, OtherUsage) {
	appProcesses := make([]ProcessSample, 0, 4)
	var appCPU float64
	var appMemory uint64
	otherByName := map[string]*AggregateProcess{}
	otherCount := 0
	for _, proc := range procs {
		// Windows reports the idle pseudo process (pid 0); it is not software using the
		// machine, and its CPU counter would drown every real row.
		if proc.pid == 0 || strings.EqualFold(proc.name, "System Idle Process") {
			continue
		}
		cpuPercent := clampPercent(proc.cpuPercent)
		if proc.role == "" {
			key := normalizeProcessName(proc.name)
			if key == "" {
				key = "unknown"
			}
			entry, ok := otherByName[key]
			if !ok {
				entry = &AggregateProcess{Name: displayName(proc.name)}
				otherByName[key] = entry
			}
			entry.Processes++
			entry.CPUPercent += cpuPercent
			entry.MemoryBytes += proc.memoryBytes
			otherCount++
			continue
		}
		appProcesses = append(appProcesses, ProcessSample{
			PID:         proc.pid,
			Name:        displayName(proc.name),
			Role:        proc.role,
			CPUPercent:  cpuPercent,
			MemoryBytes: proc.memoryBytes,
		})
		appCPU += cpuPercent
		appMemory += proc.memoryBytes
	}
	sort.Slice(appProcesses, func(i, j int) bool {
		if appProcesses[i].MemoryBytes != appProcesses[j].MemoryBytes {
			return appProcesses[i].MemoryBytes > appProcesses[j].MemoryBytes
		}
		return appProcesses[i].PID < appProcesses[j].PID
	})

	hostCPU = clampPercent(hostCPU)
	appCPU = clampPercent(appCPU)
	// The host counter and the process counters are read in separate windows, so a
	// process may briefly report more than the machine total. Clamp the aggregate to
	// the host figure: "others" must never become negative.
	if appCPU > hostCPU {
		appCPU = hostCPU
	}
	// Summed RSS counts shared pages once per process and may therefore exceed the
	// physical usage reported by the host. Clamp the aggregate for the same reason:
	// the two software shares must never overlap or exceed the machine.
	if hostUsedMemory > 0 && appMemory > hostUsedMemory {
		appMemory = hostUsedMemory
	}
	otherMemory := uint64(0)
	if hostUsedMemory > appMemory {
		otherMemory = hostUsedMemory - appMemory
	}

	return aggregatedUsage{
		processes:   appProcesses,
		cpuPercent:  appCPU,
		memoryBytes: appMemory,
	}, OtherUsage{
		CPUPercent:   clampPercent(hostCPU - appCPU),
		MemoryBytes:  otherMemory,
		ProcessCount: otherCount,
		TopProcesses: topOtherProcesses(otherByName, 8),
	}
}

// newMemoryUsage derives a consistent memory reading from the host totals: used and
// free always add up to total, and a nonsensical driver reading (available greater
// than total) is clamped instead of producing a negative "used" value.
func newMemoryUsage(total, available uint64) MemoryUsage {
	free := available
	if free > total {
		free = total
	}
	used := total - free
	usagePercent := 0.0
	if total > 0 {
		usagePercent = clampPercent(float64(used) / float64(total) * 100)
	}
	return MemoryUsage{
		TotalBytes:   total,
		UsedBytes:    used,
		FreeBytes:    free,
		UsagePercent: usagePercent,
	}
}

func (s *Sampler) loadStatic() staticInfo {
	s.staticOnce.Do(func() {
		info := staticInfo{cores: runtime.NumCPU()}
		if values, err := cpu.Counts(true); err == nil && values > 0 {
			info.cores = values
		}
		if hostInfo, err := host.Info(); err == nil && hostInfo != nil {
			info.hostname = hostInfo.Hostname
		}
		if infos, err := cpu.Info(); err == nil && len(infos) > 0 {
			info.cpuModel = strings.TrimSpace(infos[0].ModelName)
		}
		if info.hostname == "" {
			if name, err := os.Hostname(); err == nil {
				info.hostname = name
			}
		}
		s.static = info
	})
	return s.static
}

type sampledProcess struct {
	pid         int32
	name        string
	role        string
	cpuPercent  float64
	memoryBytes uint64
}

func (s *Sampler) sampleProcesses(now time.Time, cores int) []sampledProcess {
	procs, err := process.Processes()
	if err != nil {
		return nil
	}
	window := sampleWindow(now, s.prevAt, s.cfg.Interval)
	next := make(map[int32]processCPU, len(procs))
	out := make([]sampledProcess, 0, len(procs))
	for _, proc := range procs {
		if proc == nil {
			continue
		}
		pid := proc.Pid
		name, nameErr := proc.Name()
		if nameErr != nil || name == "" {
			continue
		}
		previous, hadPrevious := s.prev[pid]
		cur := processCPU{name: name}
		if hadPrevious {
			// Reuse the cached role: the executable of a running process does not
			// change, and this avoids an Exe()/Cmdline() syscall on every sample.
			cur.role = previous.role
			cur.memoryBytes = previous.memoryBytes
		}
		if cur.role == "" {
			cur.role = s.roleOf(proc, name)
		}
		if times, err := proc.Times(); err == nil && times != nil {
			cur.seconds = times.User + times.System
			cur.hasSeconds = true
		} else if hadPrevious {
			// Keep the last known counter: a transient read failure must not look like
			// a process that used zero CPU, otherwise the next delta is inflated.
			cur.seconds = previous.seconds
			cur.hasSeconds = previous.hasSeconds
		}
		if info, err := proc.MemoryInfo(); err == nil && info != nil {
			cur.memoryBytes = info.RSS
		}
		next[pid] = cur

		cpuPercent := 0.0
		if hadPrevious && cur.hasSeconds && previous.hasSeconds {
			cpuPercent = processCPUPercent(cur.seconds-previous.seconds, window, cores)
		}
		out = append(out, sampledProcess{
			pid:         pid,
			name:        name,
			role:        cur.role,
			cpuPercent:  cpuPercent,
			memoryBytes: cur.memoryBytes,
		})
	}
	s.prev = next
	s.prevAt = now
	return out
}

// sampleWindow is the wall-clock time between two process samples. A zero or
// negative distance (first sample, clock adjustments) falls back to the configured
// interval; otherwise the real distance is used so a sample delayed by a suspended
// host is averaged over the time it actually covers instead of being inflated.
func sampleWindow(now, previous time.Time, fallback time.Duration) float64 {
	if elapsed := now.Sub(previous).Seconds(); elapsed > 0 {
		return elapsed
	}
	if fallback > 0 {
		return fallback.Seconds()
	}
	return DefaultInterval.Seconds()
}

// processCPUPercent converts a CPU-time delta into a percentage of the whole machine
// (all logical cores sum to 100). Non-positive and NaN inputs yield 0, and the result
// is clamped to 100 so a bogus counter can never overflow the panel.
func processCPUPercent(deltaSeconds, windowSeconds float64, cores int) float64 {
	if cores <= 0 {
		cores = 1
	}
	if !(deltaSeconds > 0) || !(windowSeconds > 0) {
		return 0
	}
	return clampPercent(deltaSeconds / windowSeconds / float64(cores) * 100)
}

// roleOf decides whether a process belongs to this installation and which role it
// plays. The sampler's own process is always the API (whatever the executable is
// called: practacu-api.exe, PractacuPressAPI.exe or server.exe). Known executable
// names win next; then command line / executable path under one of the installation
// directories (this is how the Vite dev server is attributed).
func (s *Sampler) roleOf(proc *process.Process, name string) string {
	if proc != nil && proc.Pid == int32(os.Getpid()) {
		return "api"
	}
	normalized := normalizeProcessName(name)
	if role, ok := s.cfg.AppNames[normalized]; ok {
		return role
	}
	exe, _ := proc.Exe()
	cmdline, _ := proc.Cmdline()
	return classifyProcess(name, exe, cmdline, s.cfg.AppNames, s.cfg.AppDirs)
}

// classifyProcess is the pure decision used by roleOf, kept small for tests.
//
// Attribution intentionally has two tiers. A known executable name is enough on its
// own. Otherwise the executable must live under one of the installation directories;
// command line matching is reserved for developer tooling (node/vite/esbuild), because
// every shell that merely mentions the directory in its arguments (a terminal opened
// there, an automation host spawning commands) is not part of this software.
func classifyProcess(name, exe, cmdline string, appNames map[string]string, appDirs []string) string {
	normalized := normalizeProcessName(name)
	if role, ok := appNames[normalized]; ok {
		return role
	}
	if isPathAttributedTool(normalized) {
		haystack := strings.ToLower(exe + " " + cmdline)
		for _, dir := range appDirs {
			if dir == "" || !strings.Contains(haystack, strings.ToLower(dir)) {
				continue
			}
			if normalized == "node" || strings.Contains(haystack, "vite") {
				return "web"
			}
			return "app"
		}
		return ""
	}
	lowerExe := strings.ToLower(strings.TrimSpace(exe))
	if lowerExe == "" {
		return ""
	}
	// Compare after folding both spellings of the separator to "/": the decision must not
	// depend on the host OS (a Windows path can be classified on Linux, and vice versa).
	exePath := strings.ReplaceAll(lowerExe, `\`, "/")
	for _, dir := range appDirs {
		if dir == "" {
			continue
		}
		dirPath := strings.ReplaceAll(strings.ToLower(dir), `\`, "/")
		if exePath == dirPath || strings.HasPrefix(exePath, dirPath+"/") {
			return "app"
		}
	}
	return ""
}

// isPathAttributedTool reports whether a generic executable may be attributed to the
// installation by its command line. Only development tooling is allowed here.
func isPathAttributedTool(normalizedName string) bool {
	switch normalizedName {
	case "node", "npm", "npx", "esbuild", "vite":
		return true
	default:
		return false
	}
}

func (s *Sampler) storageFootprint(now time.Time) StorageFootprint {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	if !s.storageAt.IsZero() && now.Sub(s.storageAt) < storageRescanInterval {
		return s.storage
	}
	footprint := measureStorage(s.cfg.DataDir, s.cfg.MediaDir, s.cfg.BackupDir)
	s.storage = footprint
	s.storageAt = now
	return footprint
}

// storageRoot is one directory covered by the footprint: the data directory plus the
// media/backup directories, which may live inside or outside it.
type storageRoot struct {
	path string
	kind string // "data", "media" or "backup"
}

// measureStorage walks the configured directories and splits the bytes into
// non-overlapping buckets. Every file is counted exactly once: only the outermost
// roots are walked, and each file is attributed to the deepest configured root that
// contains it. Consequently
//
//	database + media + backup + other == total
//
// holds even when media or backups are configured outside the data directory, and the
// panel's storage bar can never overflow because of double counting.
func measureStorage(dataDir, mediaDir, backupDir string) StorageFootprint {
	footprint := StorageFootprint{DataDir: dataDir}
	roots := make([]storageRoot, 0, 3)
	if dataDir != "" {
		roots = append(roots, storageRoot{path: dataDir, kind: "data"})
	}
	if mediaDir != "" {
		roots = append(roots, storageRoot{path: mediaDir, kind: "media"})
	}
	if backupDir != "" {
		roots = append(roots, storageRoot{path: backupDir, kind: "backup"})
	}
	if len(roots) == 0 {
		return footprint
	}

	files := map[string]uint64{}
	for index := range roots {
		if storageRootCovered(roots, index) {
			continue
		}
		walkRegularFiles(roots[index].path, func(path string, size uint64) {
			files[path] = size
		})
	}
	for path, size := range files {
		footprint.TotalBytes += size
		switch storageKindOf(path, roots) {
		case "media":
			footprint.MediaBytes += size
		case "backup":
			footprint.BackupBytes += size
		default:
			if isDatabaseFile(path, dataDir) {
				footprint.DatabaseBytes += size
			} else {
				footprint.OtherBytes += size
			}
		}
	}
	return footprint
}

// storageRootCovered reports whether root i is already visited as part of another
// root: a media/backup directory under the data directory must not be walked (and
// counted) twice.
func storageRootCovered(roots []storageRoot, index int) bool {
	for otherIndex := range roots {
		if otherIndex == index {
			continue
		}
		if strings.EqualFold(filepath.Clean(roots[index].path), filepath.Clean(roots[otherIndex].path)) {
			// The same path configured twice: the first root wins.
			return index > otherIndex
		}
		if withinDir(roots[index].path, roots[otherIndex].path) {
			return true
		}
	}
	return false
}

// storageKindOf attributes a file to the deepest configured root that contains it, so
// a media directory inside the data directory wins over the data directory itself and
// a nested data directory wins over its parent media directory.
func storageKindOf(path string, roots []storageRoot) string {
	kind := "data"
	deepest := -1
	for _, root := range roots {
		if !withinDir(path, root.path) {
			continue
		}
		if length := len(root.path); length > deepest {
			deepest = length
			kind = root.kind
		}
	}
	return kind
}

// isDatabaseFile reports whether path is one of the database files at the top of the
// data directory. Explicit sqlite sidecars are included so the database bucket is
// complete instead of leaking the WAL into "other files".
func isDatabaseFile(path, dataDir string) bool {
	if dataDir == "" {
		return false
	}
	if !strings.EqualFold(filepath.Dir(filepath.Clean(path)), filepath.Clean(dataDir)) {
		return false
	}
	name := strings.ToLower(filepath.Base(path))
	return strings.HasSuffix(name, ".db") ||
		strings.HasSuffix(name, ".db-wal") ||
		strings.HasSuffix(name, ".db-shm")
}

// walkRegularFiles visits every regular file under root (or root itself when it is a
// file). Errors are ignored: a metric panel must never fail a request.
func walkRegularFiles(root string, visit func(path string, size uint64)) {
	if root == "" {
		return
	}
	info, err := os.Stat(root)
	if err != nil {
		return
	}
	if info.Mode().IsRegular() {
		visit(root, uint64(info.Size()))
		return
	}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry == nil || entry.IsDir() {
			return nil
		}
		fileInfo, statErr := entry.Info()
		if statErr != nil || fileInfo == nil || !fileInfo.Mode().IsRegular() {
			return nil
		}
		visit(path, uint64(fileInfo.Size()))
		return nil
	})
}

// withinDir reports whether path is parent itself or lives under it, so a media
// directory is not counted twice.
func withinDir(path, parent string) bool {
	cleanPath := filepath.Clean(path)
	cleanParent := filepath.Clean(parent)
	if strings.EqualFold(cleanPath, cleanParent) {
		return true
	}
	rel, err := filepath.Rel(cleanParent, cleanPath)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func topOtherProcesses(byName map[string]*AggregateProcess, limit int) []AggregateProcess {
	list := make([]AggregateProcess, 0, len(byName))
	for _, entry := range byName {
		if entry == nil {
			continue
		}
		entry.CPUPercent = round2(clampPercent(entry.CPUPercent))
		list = append(list, *entry)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].MemoryBytes != list[j].MemoryBytes {
			return list[i].MemoryBytes > list[j].MemoryBytes
		}
		if list[i].CPUPercent != list[j].CPUPercent {
			return list[i].CPUPercent > list[j].CPUPercent
		}
		return list[i].Name < list[j].Name
	})
	if limit > 0 && len(list) > limit {
		list = list[:limit]
	}
	return list
}

func normalizeAppNames(names map[string]string) map[string]string {
	out := make(map[string]string, len(names))
	for name, role := range names {
		key := normalizeProcessName(name)
		if key == "" {
			continue
		}
		out[key] = strings.TrimSpace(role)
	}
	return out
}

func normalizeDirs(dirs []string) []string {
	out := make([]string, 0, len(dirs))
	seen := map[string]struct{}{}
	for _, dir := range dirs {
		resolved := resolvePath(dir)
		if resolved == "" {
			continue
		}
		key := strings.ToLower(resolved)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, resolved)
	}
	return out
}

func resolvePath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}
	if absolute, err := filepath.Abs(trimmed); err == nil {
		trimmed = absolute
	}
	if evaluated, err := filepath.EvalSymlinks(trimmed); err == nil {
		trimmed = evaluated
	}
	return filepath.Clean(trimmed)
}

func normalizeProcessName(name string) string {
	base := strings.ToLower(strings.TrimSpace(name))
	base = strings.TrimSuffix(base, ".exe")
	base = strings.TrimSuffix(base, ".com")
	return base
}

func displayName(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "unknown"
	}
	return trimmed
}

func hostUptime() uint64 {
	seconds, err := host.Uptime()
	if err != nil {
		return 0
	}
	return seconds
}

// clampPercent clamps a possibly hostile provider reading to 0–100 and rounds it to
// two decimals. NaN is treated as 0 (a missing reading), infinities as the boundary.
func clampPercent(value float64) float64 {
	if math.IsNaN(value) || value <= 0 {
		return 0
	}
	if value >= 100 {
		return 100
	}
	return round2(value)
}

func round2(value float64) float64 {
	// Two decimals are enough for a panel and avoid float noise in JSON.
	scaled := value * 100
	if scaled >= 0 {
		scaled += 0.5
	} else {
		scaled -= 0.5
	}
	return float64(int64(scaled)) / 100
}
