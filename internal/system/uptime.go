// Package-level note: the panel's "site running time" is not the site's age and not
// the host's uptime. It is the total time this installation's API process has been
// running, summed across restarts.
//
// On startup the tracker reads the accumulated total, then adds the monotonic time
// since this process started, flushing atomically every 60 seconds and once more on
// graceful shutdown. Consequences:
//
//   - a restart continues the total instead of resetting it;
//   - a crash loses at most one flush interval (60 seconds);
//   - deleting the data directory (install reset) starts from zero, because the state
//     file lives in data/runtime;
//   - the state file is not part of backups, so restoring an old backup does not
//     shrink the counter.
//
// The document carries a version field; a newer unknown version is still read for the
// fields we know. Every failure is logged and ignored: the sampler and the panel must
// keep working even when the state file cannot be written.
package system

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// UptimeFlushInterval 是两次落盘之间的最小间隔。
	UptimeFlushInterval = 60 * time.Second

	// UptimeFileVersion 是状态文件的格式版本。
	UptimeFileVersion = 1

	// uptimeMaxSeconds 兜底坏数据：100 年的秒数，超过就按 0 处理。
	uptimeMaxSeconds = uint64(100 * 365 * 24 * 3600)

	// uptimeDirName 是状态文件所在目录（相对 data 目录）。
	uptimeDirName = "runtime"

	// uptimeFileName 是状态文件名。
	uptimeFileName = "uptime.json"
)

// UptimeConfig 配置累计运行时长追踪器。
type UptimeConfig struct {
	// Path 是状态文件；为空时只在内存里计数，不落盘。
	Path string
	// FlushEvery 是两次落盘之间的最小间隔；为零用 UptimeFlushInterval。
	FlushEvery time.Duration
	// Now 注入时钟，测试用；为空用 time.Now。
	Now func() time.Time
	// Logf 接收非致命错误；为空则丢弃。
	Logf func(format string, args ...any)
}

// UptimeDocument 是状态文件的内容。
type UptimeDocument struct {
	Version      int    `json:"version"`
	TotalSeconds uint64 `json:"total_seconds"`
	UpdatedAt    string `json:"updated_at"`
}

// UptimeTracker 记录「本次启动 + 历史累计」的软件运行时长。
type UptimeTracker struct {
	mu sync.Mutex

	path       string
	flushEvery time.Duration
	now        func() time.Time
	logf       func(format string, args ...any)

	// base 是上次进程结束前落盘的累计秒数（不含本次会话）。
	base      uint64
	startedAt time.Time
	lastFlush time.Time
	lastError string
}

// UptimePath 返回某个 data 目录下的状态文件路径；dataDir 为空时返回空串。
func UptimePath(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	return filepath.Join(dataDir, uptimeDirName, uptimeFileName)
}

// NewUptimeTracker 构造追踪器并同步读取上一次的累计值。
func NewUptimeTracker(cfg UptimeConfig) *UptimeTracker {
	tracker := &UptimeTracker{
		path:       cfg.Path,
		flushEvery: cfg.FlushEvery,
		now:        cfg.Now,
		logf:       cfg.Logf,
	}
	if tracker.flushEvery <= 0 {
		tracker.flushEvery = UptimeFlushInterval
	}
	if tracker.now == nil {
		tracker.now = time.Now
	}
	if tracker.logf == nil {
		tracker.logf = func(string, ...any) {}
	}
	tracker.load()
	started := tracker.now()
	tracker.startedAt = started
	tracker.lastFlush = started
	return tracker
}

// load 读取上一次落盘的累计值；任何异常都退回 0，不让坏文件拖住启动。
func (u *UptimeTracker) load() {
	if u.path == "" {
		return
	}
	raw, err := os.ReadFile(u.path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			u.logf("system uptime: read %s: %v", u.path, err)
		}
		return
	}
	var document UptimeDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		u.logf("system uptime: parse %s: %v (starting from zero)", u.path, err)
		return
	}
	if document.Version > UptimeFileVersion {
		u.logf(
			"system uptime: %s has version %d, known %d; reading known fields",
			u.path,
			document.Version,
			UptimeFileVersion,
		)
	}
	if document.TotalSeconds > uptimeMaxSeconds {
		u.logf(
			"system uptime: %s has an implausible total (%d), starting from zero",
			u.path,
			document.TotalSeconds,
		)
		return
	}
	u.base = document.TotalSeconds
}

// Observe 由采样循环调用：累计值按 startedAt 计算，这里只负责按节奏落盘。
func (u *UptimeTracker) Observe() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.path == "" {
		return
	}
	now := u.now()
	if now.Sub(u.lastFlush) < u.flushEvery {
		return
	}
	if err := u.flushLocked(now); err != nil {
		u.logErrorLocked(err)
	}
}

// Totals 返回本次启动时长与累计总时长（秒）。
func (u *UptimeTracker) Totals() (session, total uint64) {
	u.mu.Lock()
	defer u.mu.Unlock()
	session = secondsSince(u.startedAt, u.now())
	total = u.base + session
	if total < session {
		total = session
	}
	if total > uptimeMaxSeconds {
		total = uptimeMaxSeconds
	}
	return session, total
}

// Flush 立即落盘（退出前调用）；没有配置路径时是空操作。
func (u *UptimeTracker) Flush() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.path == "" {
		return nil
	}
	err := u.flushLocked(u.now())
	if err != nil {
		u.logErrorLocked(err)
	}
	return err
}

func (u *UptimeTracker) flushLocked(now time.Time) error {
	session := secondsSince(u.startedAt, now)
	total := u.base + session
	if total > uptimeMaxSeconds {
		total = uptimeMaxSeconds
	}
	document := UptimeDocument{
		Version:      UptimeFileVersion,
		TotalSeconds: total,
		UpdatedAt:    now.UTC().Format(time.RFC3339),
	}
	if err := writeUptimeFile(u.path, document); err != nil {
		return err
	}
	u.lastFlush = now
	u.lastError = ""
	return nil
}

// logErrorLocked 只记录同一条错误的第一次，避免每 60 秒刷一行日志。
func (u *UptimeTracker) logErrorLocked(err error) {
	if text := err.Error(); text != u.lastError {
		u.lastError = text
		u.logf("system uptime: persist %s: %v", u.path, err)
	}
}

// writeUptimeFile 通过临时文件 + rename 写入，崩溃不会留下半个 JSON。
func writeUptimeFile(path string, document UptimeDocument) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	payload, err := json.Marshal(document)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	temp, err := os.CreateTemp(dir, ".uptime-*.json")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer func() {
		// rename 成功后文件已经不在；失败时清理临时文件。
		_ = os.Remove(tempName)
	}()
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}

// secondsSince 返回两个时间点之间的整秒数；时钟回拨按 0。
func secondsSince(start, now time.Time) uint64 {
	delta := now.Sub(start)
	if delta <= 0 {
		return 0
	}
	seconds := uint64(delta / time.Second)
	if seconds > uptimeMaxSeconds {
		return uptimeMaxSeconds
	}
	return seconds
}
