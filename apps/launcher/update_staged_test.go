package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// 换版是「手动更新」里唯一可能把站点弄坏的一步，这里只盯两件事：
// 目录校验（宁可不切也不能切出一个白屏站点）与「记住换了什么」（重启不回退）。

func TestBuildDirManifest(t *testing.T) {
	valid := t.TempDir()
	writeTestFile(t, filepath.Join(valid, "index.html"), "<!doctype html><title>new</title>")
	writeTestFile(t, filepath.Join(valid, "version.json"), manifestFor(t, "0.2.0", "stable", "新版"))

	noIndex := t.TempDir()
	writeTestFile(t, filepath.Join(noIndex, "version.json"), manifestFor(t, "0.2.0", "stable", "新版"))

	emptyIndex := t.TempDir()
	writeTestFile(t, filepath.Join(emptyIndex, "index.html"), "   \n")
	writeTestFile(t, filepath.Join(emptyIndex, "version.json"), manifestFor(t, "0.2.0", "stable", "新版"))

	noManifest := t.TempDir()
	writeTestFile(t, filepath.Join(noManifest, "index.html"), "<!doctype html>")

	badManifest := t.TempDir()
	writeTestFile(t, filepath.Join(badManifest, "index.html"), "<!doctype html>")
	writeTestFile(t, filepath.Join(badManifest, "version.json"), `{"title":"x"}`)

	manifest, clean, err := buildDirManifest(valid)
	if err != nil {
		t.Fatalf("valid dir refused: %v", err)
	}
	if manifest.Version != "0.2.0" || manifest.Style != "stable" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
	if clean != filepath.Clean(valid) {
		t.Fatalf("clean = %q, want %q", clean, filepath.Clean(valid))
	}

	cases := map[string]string{
		"empty":        "  ",
		"relative":     filepath.Join("builds", "dist"),
		"missing":      filepath.Join(t.TempDir(), "nope"),
		"not a folder": filepath.Join(valid, "index.html"),
		"no index":     noIndex,
		"empty index":  emptyIndex,
		"no manifest":  noManifest,
		"bad manifest": badManifest,
	}
	for name, dir := range cases {
		if _, _, err := buildDirManifest(dir); err == nil {
			t.Errorf("%s: expected an error for %q", name, dir)
		}
	}
}

func TestUpdateApplyRemembersTheChosenBuild(t *testing.T) {
	original := distWithManifest(t, "0.1.0", "stable")
	a := newUpdateApp(t, original, nil)

	stage := t.TempDir()
	writeTestFile(t, filepath.Join(stage, "index.html"), "<!doctype html><title>staged</title>")
	writeTestFile(t, filepath.Join(stage, "version.json"), manifestFor(t, "0.2.0", "stable", "新版"))

	payload, err := json.Marshal(map[string]string{"dir": stage})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	rec := doLocal(t, a, http.MethodPost, "/__pp/update/apply", strings.NewReader(string(payload)), "application/json")
	if rec.Code != http.StatusOK {
		t.Fatalf("apply: status %d body %s", rec.Code, rec.Body.String())
	}

	state := readState(a.stateFile)
	if state.DistDir != filepath.Clean(stage) {
		t.Fatalf("state.DistDir = %q, want %q", state.DistDir, filepath.Clean(stage))
	}
	if state.Port != 0 {
		t.Fatalf("apply must not touch the port, got %d", state.Port)
	}
}

func TestRestoreStagedDistSurvivesRestart(t *testing.T) {
	stage := t.TempDir()
	writeTestFile(t, filepath.Join(stage, "index.html"), "<!doctype html><title>staged</title>")
	writeTestFile(t, filepath.Join(stage, "version.json"), manifestFor(t, "0.2.0", "stable", "新版"))

	// 第一次运行：手动切换，写入状态文件。
	first := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), nil)
	payload, err := json.Marshal(map[string]string{"dir": stage})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	rec := doLocal(t, first, http.MethodPost, "/__pp/update/apply", strings.NewReader(string(payload)), "application/json")
	if rec.Code != http.StatusOK {
		t.Fatalf("apply: status %d body %s", rec.Code, rec.Body.String())
	}

	// 重启：同一份状态文件，内置构建仍是旧的；启动时应启用上次的目录。
	second := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), nil)
	second.stateFile = first.stateFile
	version, ok := second.restoreStagedDist(readState(second.stateFile).DistDir)
	if !ok || version != "0.2.0" {
		t.Fatalf("restore = (%q, %v), want (0.2.0, true)", version, ok)
	}
	if got := second.activeDistDir(); got != filepath.Clean(stage) {
		t.Fatalf("activeDistDir = %q, want %q", got, filepath.Clean(stage))
	}
	body := doLocal(t, second, http.MethodGet, "/", nil, "").Body.String()
	if !strings.Contains(body, "staged") {
		t.Fatalf("after restart the old build is still served: %s", body)
	}
	// 上一份（内置构建）仍作为兜底保留，旧标签页的资源不会 404。
	if current, previous := second.activeDist(); previous == nil || current == nil {
		t.Fatalf("previous dist must be kept after restore")
	}
}

func TestRestoreStagedDistFallsBackWhenDirectoryIsGone(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "deleted-build")
	original := distWithManifest(t, "0.1.0", "stable")
	a := newUpdateApp(t, original, nil)
	a.stateFile = filepath.Join(t.TempDir(), stateName)
	if err := os.WriteFile(a.stateFile, []byte(`{"dist_dir":"`+strings.ReplaceAll(missing, `\`, `\\`)+`"}`), 0o644); err != nil {
		t.Fatalf("write state: %v", err)
	}

	if _, ok := a.restoreStagedDist(readState(a.stateFile).DistDir); ok {
		t.Fatalf("a missing directory must not be restored")
	}
	if a.activeDistDir() != "" {
		t.Fatalf("activeDistDir = %q, want empty (still the embedded build)", a.activeDistDir())
	}
	body := doLocal(t, a, http.MethodGet, "/", nil, "").Body.String()
	if !strings.Contains(body, "test") {
		t.Fatalf("embedded build should still be served: %s", body)
	}
}

// 防止有人把状态字段改名：旧状态文件（没有 dist_dir）读出来必须是零值而不是报错。
func TestReadStateWithoutDistDir(t *testing.T) {	file := filepath.Join(t.TempDir(), stateName)
	if err := os.WriteFile(file, []byte(`{"port":8090,"updated_at":"2026-01-01T00:00:00Z"}`), 0o644); err != nil {
		t.Fatalf("write state: %v", err)
	}
	state := readState(file)
	if state.Port != 8090 || state.DistDir != "" {
		t.Fatalf("unexpected state: %+v", state)
	}
}

// 空站点文件系统不能被当成「有内置站点」：restore 失败时不能把 dist 换成 nil。
func TestRestoreStagedDistKeepsDistOnFailure(t *testing.T) {
	a := newUpdateApp(t, fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!doctype html>")},
	}, nil)
	if _, ok := a.restoreStagedDist(""); ok {
		t.Fatal("empty dir must not be restored")
	}
	if current, _ := a.activeDist(); current == nil {
		t.Fatal("dist must stay in place after a failed restore")
	}
}

// Windows 上手工改过的 version.json 常带 UTF-8 BOM（PowerShell 5.1 的默认行为）。
// 开头一个 BOM 必须能被接受，否则「检查更新」会对一份肉眼看着完全正确的清单报无效。
func TestParseManifestAcceptsLeadingBOM(t *testing.T) {
	payload := append([]byte("\xef\xbb\xbf"), []byte(manifestFor(t, "0.2.0", "beta", "带 BOM"))...)
	manifest, err := parseManifest(payload)
	if err != nil {
		t.Fatalf("leading BOM rejected: %v", err)
	}
	if manifest.Version != "0.2.0" || manifest.Style != "beta" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
	// 只在开头放行：正文里的 BOM 仍然不是合法 JSON。
	trailing := append([]byte(manifestFor(t, "0.2.0", "beta", "x")), []byte("\xef\xbb\xbf")...)
	if _, err := parseManifest(trailing); err == nil {
		t.Fatal("a BOM after the JSON object must still be rejected")
	}
}

// 同样的事情走文件系统：带 BOM 的 version.json 必须能被 localManifest 读到。
func TestLocalManifestAcceptsBOMFile(t *testing.T) {
	dist := fstest.MapFS{
		"index.html":   &fstest.MapFile{Data: []byte("<!doctype html>")},
		"version.json": &fstest.MapFile{Data: append([]byte("\xef\xbb\xbf"), []byte(manifestFor(t, "0.2.0", "stable", "x"))...)},
	}
	manifest, ok := localManifest(dist)
	if !ok || manifest.Version != "0.2.0" {
		t.Fatalf("localManifest = (%+v, %v)", manifest, ok)
	}
}
