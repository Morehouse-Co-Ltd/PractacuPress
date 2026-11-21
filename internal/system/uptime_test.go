package system

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeClock 让运行时长可以按秒推进，而不必真的等 90 秒。
type fakeClock struct {
	at time.Time
}

func (c *fakeClock) Now() time.Time { return c.at }

func (c *fakeClock) Advance(delta time.Duration) { c.at = c.at.Add(delta) }

func newFakeClock() *fakeClock {
	return &fakeClock{at: time.Date(2026, time.November, 21, 22, 0, 0, 0, time.UTC)}
}

func readUptimeDocument(t *testing.T, path string) UptimeDocument {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read uptime state: %v", err)
	}
	var document UptimeDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("parse uptime state: %v", err)
	}
	return document
}

func newTestTracker(t *testing.T, path string, clock *fakeClock, flushEvery time.Duration) *UptimeTracker {
	t.Helper()
	return NewUptimeTracker(UptimeConfig{
		Path:       path,
		FlushEvery: flushEvery,
		Now:        clock.Now,
		Logf:       func(format string, args ...any) { t.Logf("uptime: "+format, args...) },
	})
}

func TestUptimePathFollowsDataDir(t *testing.T) {
	if got := UptimePath(""); got != "" {
		t.Fatalf("UptimePath(\"\") = %q, want empty", got)
	}
	want := filepath.Join("data", "runtime", "uptime.json")
	if got := UptimePath("data"); got != want {
		t.Fatalf("UptimePath(\"data\") = %q, want %q", got, want)
	}
}

func TestUptimeTrackerCountsSessionAndTotal(t *testing.T) {
	clock := newFakeClock()
	tracker := newTestTracker(t, UptimePath(t.TempDir()), clock, time.Minute)

	clock.Advance(90 * time.Second)
	session, total := tracker.Totals()
	if session != 90 || total != 90 {
		t.Fatalf("first session = (%d, %d), want (90, 90)", session, total)
	}

	clock.Advance(30 * time.Second)
	session, total = tracker.Totals()
	if session != 120 || total != 120 {
		t.Fatalf("after 120s session = (%d, %d), want (120, 120)", session, total)
	}
}

func TestUptimeTrackerResumesAfterRestart(t *testing.T) {
	dir := t.TempDir()
	clock := newFakeClock()

	first := newTestTracker(t, UptimePath(dir), clock, time.Minute)
	clock.Advance(2 * time.Minute)
	if err := first.Flush(); err != nil {
		t.Fatalf("flush first session: %v", err)
	}

	// 模拟进程重启：同一个状态文件、新的 tracker（会话从 0 开始）。
	clock.Advance(10 * time.Minute) // 停机时间不计入运行时长
	second := newTestTracker(t, UptimePath(dir), clock, time.Minute)
	session, total := second.Totals()
	if session != 0 || total != 120 {
		t.Fatalf("after restart = (%d, %d), want (0, 120)", session, total)
	}

	clock.Advance(45 * time.Second)
	session, total = second.Totals()
	if session != 45 || total != 165 {
		t.Fatalf("second session = (%d, %d), want (45, 165)", session, total)
	}
}

func TestUptimeTrackerPersistsOnSchedule(t *testing.T) {
	path := UptimePath(t.TempDir())
	clock := newFakeClock()
	tracker := newTestTracker(t, path, clock, time.Minute)

	clock.Advance(30 * time.Second)
	tracker.Observe()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("state written before the flush interval: err = %v", err)
	}

	clock.Advance(time.Minute) // 累计 90s，达到 flush 节奏
	tracker.Observe()
	if document := readUptimeDocument(t, path); document.TotalSeconds != 90 {
		t.Fatalf("flushed total = %d, want 90", document.TotalSeconds)
	}

	// 下一个心跳不足 60 秒：只累加内存，不重写文件。
	clock.Advance(10 * time.Second)
	tracker.Observe()
	if document := readUptimeDocument(t, path); document.TotalSeconds != 90 {
		t.Fatalf("state rewritten too early: total = %d, want 90", document.TotalSeconds)
	}
	if _, total := tracker.Totals(); total != 100 {
		t.Fatalf("in-memory total = %d, want 100", total)
	}

	// 正常退出补一次落盘，崩溃窗口内的尾巴被写进去。
	if err := tracker.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if document := readUptimeDocument(t, path); document.TotalSeconds != 100 {
		t.Fatalf("flushed total after shutdown = %d, want 100", document.TotalSeconds)
	}
}

func TestUptimeTrackerRecoversFromCorruptState(t *testing.T) {
	dir := t.TempDir()
	path := UptimePath(dir)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatalf("seed corrupt state: %v", err)
	}

	clock := newFakeClock()
	tracker := newTestTracker(t, path, clock, time.Minute)
	if session, total := tracker.Totals(); session != 0 || total != 0 {
		t.Fatalf("corrupt state = (%d, %d), want (0, 0)", session, total)
	}

	clock.Advance(5 * time.Second)
	if err := tracker.Flush(); err != nil {
		t.Fatalf("flush after corrupt state: %v", err)
	}
	document := readUptimeDocument(t, path)
	if document.Version != UptimeFileVersion || document.TotalSeconds != 5 {
		t.Fatalf("repaired document = %+v, want version %d total 5", document, UptimeFileVersion)
	}
}

func TestUptimeTrackerClampsBackwardsClock(t *testing.T) {
	clock := newFakeClock()
	tracker := newTestTracker(t, UptimePath(t.TempDir()), clock, time.Minute)

	clock.Advance(-10 * time.Minute)
	if session, total := tracker.Totals(); session != 0 || total != 0 {
		t.Fatalf("backwards clock = (%d, %d), want (0, 0)", session, total)
	}
}

func TestUptimeTrackerMemoryOnlyWithoutPath(t *testing.T) {
	clock := newFakeClock()
	tracker := NewUptimeTracker(UptimeConfig{Now: clock.Now})
	clock.Advance(10 * time.Second)
	tracker.Observe()
	if err := tracker.Flush(); err != nil {
		t.Fatalf("flush without path: %v", err)
	}
	if session, total := tracker.Totals(); session != 10 || total != 10 {
		t.Fatalf("memory only = (%d, %d), want (10, 10)", session, total)
	}
	if tracker.path != "" {
		t.Fatalf("memory-only tracker path = %q, want empty", tracker.path)
	}
}

func TestSamplerReportsUptime(t *testing.T) {
	if testing.Short() {
		t.Skip("samples the real process table")
	}
	clock := newFakeClock()
	tracker := newTestTracker(t, UptimePath(t.TempDir()), clock, time.Minute)
	sampler := NewSampler(SamplerConfig{Uptime: tracker})

	clock.Advance(5 * time.Second)
	sampler.sampleOnce()
	snapshot := sampler.Latest()
	if snapshot.App.UptimeSeconds != 5 || snapshot.App.TotalUptimeSeconds != 5 {
		t.Fatalf(
			"sampler uptime = (%d, %d), want (5, 5)",
			snapshot.App.UptimeSeconds,
			snapshot.App.TotalUptimeSeconds,
		)
	}

	clock.Advance(3 * time.Second)
	sampler.sampleOnce()
	snapshot = sampler.Latest()
	if snapshot.App.UptimeSeconds != 8 || snapshot.App.TotalUptimeSeconds != 8 {
		t.Fatalf(
			"sampler uptime = (%d, %d), want (8, 8)",
			snapshot.App.UptimeSeconds,
			snapshot.App.TotalUptimeSeconds,
		)
	}
}

func TestSamplerWithoutUptimeLeavesZero(t *testing.T) {
	if testing.Short() {
		t.Skip("samples the real process table")
	}
	sampler := NewSampler(SamplerConfig{})
	sampler.sampleOnce()
	snapshot := sampler.Latest()
	if snapshot.App.UptimeSeconds != 0 || snapshot.App.TotalUptimeSeconds != 0 {
		t.Fatalf("uptime without a tracker = (%d, %d), want (0, 0)",
			snapshot.App.UptimeSeconds, snapshot.App.TotalUptimeSeconds)
	}
}
