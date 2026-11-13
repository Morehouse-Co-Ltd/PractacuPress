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
}

// OtherUsage is everything attributed to the rest of the machine.
type OtherUsage struct {
	CPUPercent   float64            `json:"cpu_percent"`
	MemoryBytes  uint64             `json:"memory_bytes"`
	ProcessCount int                `json:"process_count"`
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
}

// DefaultAppNames returns the executable names this installation ships.
func DefaultAppNames() map[string]string {
	return map[string]string{
		"practacu-api":      "api",
		"practacu-security": "security",
		"practacupress":     "launcher",
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
	s.sampleOnce()
	go func() {
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
		memory = MemoryUsage{
			TotalBytes:   vm.Total,
			UsedBytes:    vm.Total - vm.Available,
			FreeBytes:    vm.Available,
			UsagePercent: clampPercent(float64(vm.Total-vm.Available) / float64(maxUint64(vm.Total, 1)) * 100),
		}
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

	procs := s.sampleProcesses(now, static.cores)
	appProcesses := make([]ProcessSample, 0, 4)
	var appCPU float64
	var appMemory uint64
	otherByName := map[string]*AggregateProcess{}
	processCount := 0
	if procs != nil {
		processCount = len(procs)
	}
	for _, proc := range procs {
		// Windows reports the idle pseudo process (pid 0); it is not software using the
		// machine, and its CPU counter would drown every real row.
		if proc.pid == 0 || strings.EqualFold(proc.name, "System Idle Process") {
			continue
		}
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
			entry.CPUPercent += proc.cpuPercent
			entry.MemoryBytes += proc.memoryBytes
			continue
		}
		appProcesses = append(appProcesses, ProcessSample{
			PID:         proc.pid,
			Name:        displayName(proc.name),
			Role:        proc.role,
			CPUPercent:  proc.cpuPercent,
			MemoryBytes: proc.memoryBytes,
		})
		appCPU += proc.cpuPercent
		appMemory += proc.memoryBytes
	}
	sort.Slice(appProcesses, func(i, j int) bool {
		if appProcesses[i].MemoryBytes != appProcesses[j].MemoryBytes {
			return appProcesses[i].MemoryBytes > appProcesses[j].MemoryBytes
		}
		return appProcesses[i].PID < appProcesses[j].PID
	})
	topOthers := topOtherProcesses(otherByName, 8)

	appCPU = clampPercent(appCPU)
	otherCPU := hostCPU - appCPU
	if otherCPU < 0 {
		otherCPU = 0
	}
	otherMemory := uint64(0)
	if memory.UsedBytes > appMemory {
		otherMemory = memory.UsedBytes - appMemory
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
			Processes:   appProcesses,
			CPUPercent:  appCPU,
			MemoryBytes: appMemory,
			Storage:     s.storageFootprint(now),
		},
		Others: OtherUsage{
			CPUPercent:   clampPercent(otherCPU),
			MemoryBytes:  otherMemory,
			ProcessCount: processCount,
			TopProcesses: topOthers,
		},
	}

	s.mu.Lock()
	s.snapshot = snapshot
	s.mu.Unlock()
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
	if cores <= 0 {
		cores = 1
	}
	elapsed := now.Sub(s.prevAt).Seconds()
	if elapsed <= 0 || elapsed > 30 {
		elapsed = s.cfg.Interval.Seconds()
	}
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
		cur := processCPU{name: name}
		if previous, ok := s.prev[pid]; ok {
			cur.role = previous.role
			cur.memoryBytes = previous.memoryBytes
		}
		if cur.role == "" {
			cur.role = s.roleOf(proc, name)
		}
		if times, err := proc.Times(); err == nil && times != nil {
			cur.seconds = times.User + times.System
		}
		if info, err := proc.MemoryInfo(); err == nil && info != nil {
			cur.memoryBytes = info.RSS
		}
		next[pid] = cur

		pct := 0.0
		if previous, ok := s.prev[pid]; ok && elapsed > 0 {
			delta := cur.seconds - previous.seconds
			if delta > 0 {
				pct = clampPercent(delta / elapsed / float64(cores) * 100)
			}
		}
		out = append(out, sampledProcess{
			pid:         pid,
			name:        name,
			role:        cur.role,
			cpuPercent:  round2(pct),
			memoryBytes: cur.memoryBytes,
		})
	}
	s.prev = next
	s.prevAt = now
	return out
}

// roleOf decides whether a process belongs to this installation and which role it
// plays. Known executable names win; then command line / executable path under one
// of the installation directories (this is how the Vite dev server is attributed).
func (s *Sampler) roleOf(proc *process.Process, name string) string {
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
	for _, dir := range appDirs {
		if dir == "" {
			continue
		}
		lowered := strings.ToLower(dir)
		if lowerExe == lowered || strings.HasPrefix(lowerExe, lowered+string(filepath.Separator)) ||
			strings.HasPrefix(lowerExe, lowered+"/") {
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

// measureStorage walks the configured directories. Missing paths contribute zero;
// the walk is best effort because a metric panel must never fail the request.
func measureStorage(dataDir, mediaDir, backupDir string) StorageFootprint {
	footprint := StorageFootprint{DataDir: dataDir}
	if dataDir == "" {
		return footprint
	}
	footprint.TotalBytes = dirSize(dataDir)
	footprint.DatabaseBytes = databaseSize(dataDir)
	if mediaDir != "" && withinDir(mediaDir, dataDir) {
		footprint.MediaBytes = dirSize(mediaDir)
	} else if mediaDir != "" {
		footprint.MediaBytes = dirSize(mediaDir)
	}
	if backupDir != "" {
		footprint.BackupBytes = dirSize(backupDir)
	}
	covered := footprint.DatabaseBytes + footprint.MediaBytes + footprint.BackupBytes
	if footprint.TotalBytes > covered {
		footprint.OtherBytes = footprint.TotalBytes - covered
	}
	return footprint
}

func databaseSize(dataDir string) uint64 {
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		return 0
	}
	var total uint64
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := strings.ToLower(entry.Name())
		if !strings.HasSuffix(name, ".db") &&
			!strings.HasSuffix(name, ".db-wal") &&
			!strings.HasSuffix(name, ".db-shm") {
			continue
		}
		if info, err := entry.Info(); err == nil && info != nil {
			total += uint64(info.Size())
		}
	}
	return total
}

func dirSize(path string) uint64 {
	if path == "" {
		return 0
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	if info.Mode().IsRegular() {
		return uint64(info.Size())
	}
	var total uint64
	_ = filepath.WalkDir(path, func(_ string, entry os.DirEntry, err error) error {
		if err != nil || entry == nil || entry.IsDir() {
			return nil
		}
		if info, statErr := entry.Info(); statErr == nil && info != nil && info.Mode().IsRegular() {
			total += uint64(info.Size())
		}
		return nil
	})
	return total
}

// withinDir reports whether path is dataDir itself or lives under it, so a media
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

func clampPercent(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 100 {
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

func maxUint64(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}
