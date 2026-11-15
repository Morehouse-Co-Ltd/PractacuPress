package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

/* ---------- 辅助 ---------- */

// newUpdateApp 造一个只带站点文件系统的 app，不监听端口。
func newUpdateApp(t *testing.T, dist fs.FS, fetcher *manifestFetcher) *app {
	t.Helper()
	return &app{
		dist:      dist,
		distReady: dist != nil,
		stateFile: filepath.Join(t.TempDir(), stateName),
		snapshots: map[string]snapshot{},
		mode:      modeDemo,
		port:      18099,
		fetcher:   fetcher,
	}
}

// doLocal 发一个本机页面会发的请求：回环对端、回环 Host，没有转发头。
func doLocal(t *testing.T, a *app, method, target string, body io.Reader, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "http://127.0.0.1:18099"+target, body)
	req.Host = "127.0.0.1:18099"
	req.RemoteAddr = "127.0.0.1:50000"
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	return rec
}

// manifestFor 拼一份合法清单。
func manifestFor(t *testing.T, version, style, describe string) string {
	t.Helper()
	payload, err := json.Marshal(VersionManifest{
		Title:    "Practacu Press",
		Describe: describe,
		Version:  version,
		Style:    style,
	})
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	return string(payload)
}

// distWithManifest 造一份「带清单的内置站点」。
func distWithManifest(t *testing.T, version, style string) fstest.MapFS {
	t.Helper()
	return fstest.MapFS{
		"index.html":   &fstest.MapFile{Data: []byte("<!doctype html><title>test</title>")},
		"version.json": &fstest.MapFile{Data: []byte(manifestFor(t, version, style, "本机站点"))},
	}
}

func writeTestFile(t *testing.T, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", name, err)
	}
	if err := os.WriteFile(name, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", name, err)
	}
}

// newTestFetcher 起一个 TLS 测试服务，并把它注入允许列表。
//
// 用 TLS 而不是 http，是因为生产策略只接受 https；测试不该为了跑通而放宽这条策略，
// 于是让测试服务自己提供 https，再让 fetcher 用 srv.Client() 信任它的证书。
func newTestFetcher(t *testing.T, handler http.HandlerFunc) (*manifestFetcher, string) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("httptest url: %v", err)
	}
	fetcher := newManifestFetcher(parsed.Host)
	fetcher.client = server.Client()
	return fetcher, server.URL + "/version.json"
}

// roundTripFunc 让测试直接控制传输层，构造超时/连接失败这类分支。
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func failureKind(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	var failure *updateFailure
	if !errors.As(err, &failure) {
		t.Fatalf("error %v is not an updateFailure", err)
	}
	return failure.kind
}

type updateCheckBody struct {
	OK              bool             `json:"ok"`
	Source          string           `json:"source"`
	FetchedAt       string           `json:"fetched_at"`
	Local           *VersionManifest `json:"local"`
	Remote          *VersionManifest `json:"remote"`
	UpdateAvailable bool             `json:"update_available"`
	Reason          string           `json:"reason"`
}

func decodeCheck(t *testing.T, rec *httptest.ResponseRecorder) updateCheckBody {
	t.Helper()
	var body updateCheckBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("check response is not JSON: %v (%s)", err, rec.Body.String())
	}
	return body
}

/* ---------- 清单解析 ---------- */

func TestParseManifest(t *testing.T) {
	cases := []struct {
		name string
		body string
		want VersionManifest
		ok   bool
	}{
		{
			name: "four fields",
			body: `{"title":"Practacu Press","describe":"本机内容站点","version":"0.1.1-beta","style":"beta"}`,
			want: VersionManifest{Title: "Practacu Press", Describe: "本机内容站点", Version: "0.1.1-beta", Style: "beta"},
			ok:   true,
		},
		{
			name: "stable without prerelease",
			body: `{"title":"T","describe":"D","version":"1.2.3","style":"stable"}`,
			want: VersionManifest{Title: "T", Describe: "D", Version: "1.2.3", Style: "stable"},
			ok:   true,
		},
		{
			name: "v prefix and build metadata",
			body: `{"title":"T","describe":"D","version":"v1.2.3-beta.1+20260101","style":"local"}`,
			want: VersionManifest{Title: "T", Describe: "D", Version: "v1.2.3-beta.1+20260101", Style: "local"},
			ok:   true,
		},
		{
			// 与前端一致：首尾空白先去掉，免得只填了空格的字段看起来像填过。
			name: "trims every field",
			body: `{"title":"  T  ","describe":" D ","version":" 1.2.3 ","style":" stable "}`,
			want: VersionManifest{Title: "T", Describe: "D", Version: "1.2.3", Style: "stable"},
			ok:   true,
		},
		{name: "missing title", body: `{"describe":"D","version":"1.0.0","style":"stable"}`},
		{name: "missing describe", body: `{"title":"T","version":"1.0.0","style":"stable"}`},
		{name: "missing version", body: `{"title":"T","describe":"D","style":"stable"}`},
		{name: "missing style", body: `{"title":"T","describe":"D","version":"1.0.0"}`},
		{name: "blank title", body: `{"title":"   ","describe":"D","version":"1.0.0","style":"stable"}`},
		{name: "null title", body: `{"title":null,"describe":"D","version":"1.0.0","style":"stable"}`},
		{name: "two part version", body: `{"title":"T","describe":"D","version":"1.2","style":"stable"}`},
		{name: "four part version", body: `{"title":"T","describe":"D","version":"1.2.3.4","style":"stable"}`},
		{name: "version words", body: `{"title":"T","describe":"D","version":"latest","style":"stable"}`},
		{name: "unknown style", body: `{"title":"T","describe":"D","version":"1.0.0","style":"nightly"}`},
		{name: "array", body: `[]`},
		{name: "array of manifests", body: `[{"title":"T","describe":"D","version":"1.0.0","style":"stable"}]`},
		{name: "bare string", body: `"1.0.0"`},
		{name: "null document", body: `null`},
		{name: "wrong field type", body: `{"title":42,"describe":"D","version":"1.0.0","style":"stable"}`},
		{name: "broken json", body: `{"title":`},
		{name: "trailing garbage", body: `{"title":"T","describe":"D","version":"1.0.0","style":"stable"}{}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseManifest([]byte(tc.body))
			if !tc.ok {
				if err == nil {
					t.Fatalf("parseManifest(%s) must be rejected, got %+v", tc.body, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseManifest(%s): %v", tc.body, err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("parseManifest(%s) = %+v, want %+v", tc.body, got, tc.want)
			}
		})
	}
}

func TestLocalManifest(t *testing.T) {
	if _, ok := localManifest(nil); ok {
		t.Fatal("a nil dist has no manifest")
	}
	if _, ok := localManifest(fstest.MapFS{}); ok {
		t.Fatal("a dist without version.json has no manifest")
	}
	broken := fstest.MapFS{"version.json": &fstest.MapFile{Data: []byte(`{"title":"T"}`)}}
	if _, ok := localManifest(broken); ok {
		t.Fatal("an invalid version.json must not count as a manifest")
	}

	manifest, ok := localManifest(distWithManifest(t, "0.1.1-beta", "beta"))
	if !ok || manifest.Version != "0.1.1-beta" || manifest.Style != "beta" {
		t.Fatalf("unexpected local manifest: %+v (ok=%v)", manifest, ok)
	}
}

/* ---------- 版本比较 ---------- */

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		// 完全相等，v 前缀不影响比较。
		{"0.1.0", "0.1.0", 0},
		{"v0.1.0", "0.1.0", 0},
		{"1.0.0+build.5", "1.0.0", 0},
		{"1.0.0-rc.1+build", "1.0.0-rc.1", 0},
		// 三段数字。
		{"0.2.0", "0.1.9", 1},
		{"0.1.9", "0.2.0", -1},
		{"10.0.0", "9.9.9", 1},
		{"1.0.10", "1.0.9", 1},
		// 没有预发布标签的一方更新。
		{"0.2.0", "0.2.0-beta", 1},
		{"0.2.0-beta", "0.2.0", -1},
		// 预发布段：数字按数值比，数字段比字母段旧。
		{"0.2.0-beta.2", "0.2.0-beta.10", -1},
		{"0.2.0-beta.10", "0.2.0-beta.2", 1},
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		{"1.0.0-alpha.1", "1.0.0-beta", -1},
		{"1.0.0-1", "1.0.0-alpha", -1},
		{"1.0.0-alpha", "1.0.0-1", 1},
		// 无法解析的一律算相等：损坏的清单不能让人以为有新版本。
		{"nope", "1.0.0", 0},
		{"1.0.0", "nope", 0},
		{"", "1.0.0", 0},
	}
	for _, tc := range cases {
		if got := compareVersions(tc.a, tc.b); got != tc.want {
			t.Fatalf("compareVersions(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
		// 反对称性：反过来比较必须取反。
		if got := compareVersions(tc.b, tc.a); got != -tc.want {
			t.Fatalf("compareVersions(%q, %q) = %d, want %d", tc.b, tc.a, got, -tc.want)
		}
	}
}

/* ---------- 更新源策略 ---------- */

func TestManifestSourcePolicy(t *testing.T) {
	fetcher := newManifestFetcher()

	remote := []string{
		defaultManifestSource,
		"https://github.com/practacu/practacu-press/raw/main/apps/web/public/version.json",
		"https://cdn.jsdelivr.net/gh/practacu/practacu-press@main/apps/web/public/version.json",
		"https://gitee.com/practacu/practacu-press/raw/main/apps/web/public/version.json",
		"https://RAW.GITHUBUSERCONTENT.COM/practacu/practacu-press/main/apps/web/public/version.json",
	}
	for _, raw := range remote {
		source, err := fetcher.resolveSource(raw)
		if err != nil {
			t.Fatalf("resolveSource(%q) must be allowed: %v", raw, err)
		}
		if source.local || source.remote != raw {
			t.Fatalf("resolveSource(%q) = %+v, want a remote source", raw, source)
		}
	}

	// 空参数回落到默认源：页面没选更新源时也要能查。
	defaulted, err := fetcher.resolveSource("   ")
	if err != nil {
		t.Fatalf("empty source must fall back to the default: %v", err)
	}
	if defaulted.remote != defaultManifestSource {
		t.Fatalf("empty source resolved to %q, want %q", defaulted.remote, defaultManifestSource)
	}

	// 本站源：只读 dist 里的 version.json，不产生网络请求。
	local, err := fetcher.resolveSource("/version.json")
	if err != nil {
		t.Fatalf("/version.json must be allowed: %v", err)
	}
	if !local.local || local.raw != localManifestPath {
		t.Fatalf("/version.json resolved to %+v, want a local source", local)
	}

	// 地址写错与地址不被允许要分开：前者 400，后者 403。
	refusedInvalid := []string{
		"https:///version.json",
		"https://",
		"not a url",
		"version.json",
		"//evil.example/version.json",
		"/index.html",
		"/version.json.bak",
		"/assets/version.json",
		"/etc/passwd",
	}
	for _, raw := range refusedInvalid {
		if _, err := fetcher.resolveSource(raw); err == nil {
			t.Fatalf("resolveSource(%q) must be refused", raw)
		} else if failureKind(t, err) != updateSourceInvalid {
			t.Fatalf("resolveSource(%q) failed with %s, want %s", raw, failureKind(t, err), updateSourceInvalid)
		}
	}

	refusedForbidden := []string{
		"http://raw.githubusercontent.com/practacu/practacu-press/main/version.json",
		"ftp://raw.githubusercontent.com/practacu/practacu-press/main/version.json",
		"https://evil.example/version.json",
		"https://raw.githubusercontent.com.evil.example/version.json",
		"https://raw.githubusercontent.com@evil.example/version.json",
		"https://user:pass@raw.githubusercontent.com/version.json",
		"https://attacker.example.test:8443/version.json",
		"http://127.0.0.1:8080/__pp/runtime",
	}
	for _, raw := range refusedForbidden {
		if _, err := fetcher.resolveSource(raw); err == nil {
			t.Fatalf("resolveSource(%q) must be refused", raw)
		} else if failureKind(t, err) != updateSourceForbidden {
			t.Fatalf("resolveSource(%q) failed with %s, want %s", raw, failureKind(t, err), updateSourceForbidden)
		}
	}
}

func TestManifestFetcherExtraHostsRequirePort(t *testing.T) {
	fetcher := newManifestFetcher("127.0.0.1:1234")
	if _, err := fetcher.resolveSource("https://127.0.0.1:1234/version.json"); err != nil {
		t.Fatalf("the injected host must be allowed: %v", err)
	}
	// 允许 127.0.0.1:1234 不等于允许这台机器的所有端口。
	if _, err := fetcher.resolveSource("https://127.0.0.1:4321/version.json"); err == nil {
		t.Fatal("another port on the injected host must be refused")
	}
}

/* ---------- 抓取 ---------- */

func TestManifestFetchSucceeds(t *testing.T) {
	var gotAccept string
	fetcher, raw := newTestFetcher(t, func(w http.ResponseWriter, r *http.Request) {
		gotAccept = r.Header.Get("Accept")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, manifestFor(t, "0.2.0", "stable", "远端站点"))
	})
	source, err := fetcher.resolveSource(raw)
	if err != nil {
		t.Fatalf("resolveSource: %v", err)
	}
	manifest, err := fetcher.fetch(context.Background(), source.remote)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if manifest.Version != "0.2.0" || manifest.Style != "stable" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
	if gotAccept != "application/json" {
		t.Fatalf("Accept header = %q, want application/json", gotAccept)
	}
}

func TestManifestFetchFailures(t *testing.T) {
	t.Run("oversized body", func(t *testing.T) {
		fetcher, raw := newTestFetcher(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, strings.Repeat("a", 70<<10))
		})
		source, err := fetcher.resolveSource(raw)
		if err != nil {
			t.Fatalf("resolveSource: %v", err)
		}
		if _, err := fetcher.fetch(context.Background(), source.remote); failureKind(t, err) != updateUpstreamFailed {
			t.Fatalf("oversized body mapped to %s, want %s", failureKind(t, err), updateUpstreamFailed)
		}
	})

	t.Run("invalid json", func(t *testing.T) {
		fetcher, raw := newTestFetcher(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"title":`)
		})
		source, err := fetcher.resolveSource(raw)
		if err != nil {
			t.Fatalf("resolveSource: %v", err)
		}
		if _, err := fetcher.fetch(context.Background(), source.remote); failureKind(t, err) != updateManifestInvalid {
			t.Fatalf("invalid json mapped to %s, want %s", failureKind(t, err), updateManifestInvalid)
		}
	})

	t.Run("non 200", func(t *testing.T) {
		fetcher, raw := newTestFetcher(t, func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "gone", http.StatusServiceUnavailable)
		})
		source, err := fetcher.resolveSource(raw)
		if err != nil {
			t.Fatalf("resolveSource: %v", err)
		}
		if _, err := fetcher.fetch(context.Background(), source.remote); failureKind(t, err) != updateUpstreamFailed {
			t.Fatalf("non 200 mapped to %s, want %s", failureKind(t, err), updateUpstreamFailed)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		fetcher := newManifestFetcher("updates.example.test")
		fetcher.client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, context.DeadlineExceeded
		})}
		source, err := fetcher.resolveSource("https://updates.example.test/version.json")
		if err != nil {
			t.Fatalf("resolveSource: %v", err)
		}
		if _, err := fetcher.fetch(context.Background(), source.remote); failureKind(t, err) != updateUpstreamTimeout {
			t.Fatalf("timeout mapped to %s, want %s", failureKind(t, err), updateUpstreamTimeout)
		}
	})

	t.Run("transport error", func(t *testing.T) {
		fetcher := newManifestFetcher("updates.example.test")
		fetcher.client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("dial tcp: connection refused")
		})}
		source, err := fetcher.resolveSource("https://updates.example.test/version.json")
		if err != nil {
			t.Fatalf("resolveSource: %v", err)
		}
		if _, err := fetcher.fetch(context.Background(), source.remote); failureKind(t, err) != updateUpstreamFailed {
			t.Fatalf("transport error mapped to %s, want %s", failureKind(t, err), updateUpstreamFailed)
		}
	})

	t.Run("redirect", func(t *testing.T) {
		// 跳转目标就在同一个测试服务里、而且是合法的清单：如果 fetch 跟了跳转，
		// 这里会拿到 9.9.9 而不是报错，测试就抓住「跳转能绕过允许列表」的回归。
		fetcher, raw := newTestFetcher(t, func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/elsewhere") {
				_, _ = io.WriteString(w, manifestFor(t, "9.9.9", "stable", "跳转目标"))
				return
			}
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
		})
		source, err := fetcher.resolveSource(raw)
		if err != nil {
			t.Fatalf("resolveSource: %v", err)
		}
		if _, err := fetcher.fetch(context.Background(), source.remote); failureKind(t, err) != updateUpstreamFailed {
			t.Fatalf("a redirect mapped to %s, want %s", failureKind(t, err), updateUpstreamFailed)
		}
	})
}

/* ---------- 检查更新接口 ---------- */

func TestUpdateCheckReportsNewerRemote(t *testing.T) {
	fetcher, remoteURL := newTestFetcher(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, manifestFor(t, "0.2.0", "stable", "远端站点"))
	})
	a := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), fetcher)

	rec := doLocal(t, a, http.MethodGet, "/__pp/update?source="+url.QueryEscape(remoteURL), nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("check returned %d: %s", rec.Code, rec.Body.String())
	}
	body := decodeCheck(t, rec)
	if !body.OK {
		t.Fatalf("check did not report ok: %s", rec.Body.String())
	}
	if body.Source != remoteURL {
		t.Fatalf("source = %q, want %q", body.Source, remoteURL)
	}
	if body.Local == nil || body.Local.Version != "0.1.0" {
		t.Fatalf("local manifest missing or wrong: %+v", body.Local)
	}
	if body.Remote == nil || body.Remote.Version != "0.2.0" {
		t.Fatalf("remote manifest missing or wrong: %+v", body.Remote)
	}
	if !body.UpdateAvailable || body.Reason != "newer" {
		t.Fatalf("update_available=%v reason=%q, want true/newer", body.UpdateAvailable, body.Reason)
	}
	if !strings.HasSuffix(body.FetchedAt, "Z") {
		t.Fatalf("fetched_at = %q, want a UTC RFC3339 timestamp", body.FetchedAt)
	}
	if _, err := time.Parse(time.RFC3339, body.FetchedAt); err != nil {
		t.Fatalf("fetched_at %q is not RFC3339: %v", body.FetchedAt, err)
	}
}

func TestUpdateCheckReportsOlderRemote(t *testing.T) {
	fetcher, remoteURL := newTestFetcher(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, manifestFor(t, "0.0.9", "stable", "远端站点"))
	})
	a := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), fetcher)

	body := decodeCheck(t, doLocal(t, a, http.MethodGet, "/__pp/update?source="+url.QueryEscape(remoteURL), nil, ""))
	if body.UpdateAvailable || body.Reason != "older" {
		t.Fatalf("update_available=%v reason=%q, want false/older", body.UpdateAvailable, body.Reason)
	}
}

func TestUpdateCheckLocalSource(t *testing.T) {
	a := newUpdateApp(t, distWithManifest(t, "0.1.0", "beta"), nil)
	rec := doLocal(t, a, http.MethodGet, "/__pp/update?source=%2Fversion.json", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("local source returned %d: %s", rec.Code, rec.Body.String())
	}
	body := decodeCheck(t, rec)
	if body.Source != localManifestPath {
		t.Fatalf("source = %q, want %q", body.Source, localManifestPath)
	}
	if body.UpdateAvailable || body.Reason != "same" {
		t.Fatalf("update_available=%v reason=%q, want false/same", body.UpdateAvailable, body.Reason)
	}
	if body.Remote == nil || body.Local == nil || body.Remote.Version != body.Local.Version {
		t.Fatalf("local source must compare the manifest with itself: %+v / %+v", body.Local, body.Remote)
	}
}

func TestUpdateCheckWithoutLocalManifest(t *testing.T) {
	fetcher, remoteURL := newTestFetcher(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, manifestFor(t, "0.2.0", "stable", "远端站点"))
	})
	a := newUpdateApp(t, fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>no manifest</title>")},
	}, fetcher)

	rec := doLocal(t, a, http.MethodGet, "/__pp/update?source="+url.QueryEscape(remoteURL), nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("check returned %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"local"`) {
		t.Fatalf("a missing local manifest must be omitted, not sent as zeros: %s", rec.Body.String())
	}
	body := decodeCheck(t, rec)
	if body.Local != nil {
		t.Fatalf("local = %+v, want nil", body.Local)
	}
	if body.UpdateAvailable || body.Reason != "same" {
		t.Fatalf("without a local version nothing is newer: update_available=%v reason=%q", body.UpdateAvailable, body.Reason)
	}

	// 没有清单却选「本站」：文件不存在，404（与 npm start 的静态服务一致）。
	rec = doLocal(t, a, http.MethodGet, "/__pp/update?source=%2Fversion.json", nil, "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "not_found") {
		t.Fatalf("local source without a manifest returned %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateCheckErrors(t *testing.T) {
	t.Run("not local control", func(t *testing.T) {
		a := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), nil)
		req := httptest.NewRequest(http.MethodGet, "http://press.example.com/__pp/update", nil)
		req.Host = "press.example.com"
		req.RemoteAddr = "127.0.0.1:50000"
		rec := httptest.NewRecorder()
		a.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("public host returned %d, want 403: %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `"permission_denied"`) {
			t.Fatalf("403 body does not name permission_denied: %s", rec.Body.String())
		}
	})

	t.Run("wrong method", func(t *testing.T) {
		a := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), nil)
		rec := doLocal(t, a, http.MethodPost, "/__pp/update", strings.NewReader("{}"), "application/json")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("POST returned %d, want 405: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("source not allowed", func(t *testing.T) {
		a := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), newManifestFetcher())
		rec := doLocal(t, a, http.MethodGet, "/__pp/update?source="+url.QueryEscape("https://evil.example/version.json"), nil, "")
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "permission_denied") {
			t.Fatalf("refused source returned %d: %s", rec.Code, rec.Body.String())
		}
		// 明文 http 同样是不被允许的来源，也不能泄露成 400「你填错了」。
		rec = doLocal(t, a, http.MethodGet, "/__pp/update?source="+url.QueryEscape("http://raw.githubusercontent.com/x/version.json"), nil, "")
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "permission_denied") {
			t.Fatalf("plain http source returned %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("local path is not a manifest", func(t *testing.T) {
		a := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), newManifestFetcher())
		rec := doLocal(t, a, http.MethodGet, "/__pp/update?source=%2Findex.html", nil, "")
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "validation_failed") {
			t.Fatalf("bad local path returned %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("upstream status", func(t *testing.T) {
		fetcher, remoteURL := newTestFetcher(t, func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "boom", http.StatusInternalServerError)
		})
		a := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), fetcher)
		rec := doLocal(t, a, http.MethodGet, "/__pp/update?source="+url.QueryEscape(remoteURL), nil, "")
		if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "upstream_failed") {
			t.Fatalf("upstream 500 returned %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("invalid remote manifest", func(t *testing.T) {
		fetcher, remoteURL := newTestFetcher(t, func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, `{"title":"","describe":"","version":"","style":""}`)
		})
		a := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), fetcher)
		rec := doLocal(t, a, http.MethodGet, "/__pp/update?source="+url.QueryEscape(remoteURL), nil, "")
		if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "upstream_failed") {
			t.Fatalf("invalid manifest returned %d: %s", rec.Code, rec.Body.String())
		}
		// 错误信息要是中文短句，页面可以直接展示。
		if !strings.Contains(rec.Body.String(), "清单") {
			t.Fatalf("invalid manifest message is not explanatory: %s", rec.Body.String())
		}
	})

	t.Run("upstream timeout", func(t *testing.T) {
		fetcher := newManifestFetcher("updates.example.test")
		fetcher.client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, context.DeadlineExceeded
		})}
		a := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), fetcher)
		rec := doLocal(t, a, http.MethodGet, "/__pp/update?source="+url.QueryEscape("https://updates.example.test/version.json"), nil, "")
		if rec.Code != http.StatusGatewayTimeout || !strings.Contains(rec.Body.String(), "upstream_timeout") {
			t.Fatalf("timeout returned %d: %s", rec.Code, rec.Body.String())
		}
	})
}

/* ---------- 不停服换版 ---------- */

func TestPromoteServesNewBuildAndKeepsOldAssets(t *testing.T) {
	oldDist := fstest.MapFS{
		"index.html":         &fstest.MapFile{Data: []byte(`<!doctype html><title>v1</title><script src="/assets/old-hash.js"></script>`)},
		"assets/old-hash.js": &fstest.MapFile{Data: []byte("window.oldBuild = true;")},
		"version.json":       &fstest.MapFile{Data: []byte(manifestFor(t, "0.1.0", "stable", "旧版"))},
	}
	a := newUpdateApp(t, oldDist, nil)
	a.mu.Lock()
	a.activeVersion = "0.1.0"
	a.mu.Unlock()

	if rec := doLocal(t, a, http.MethodGet, "/assets/old-hash.js", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("the old asset must be served before the swap, got %d", rec.Code)
	}

	nextDist := fstest.MapFS{
		"index.html":         &fstest.MapFile{Data: []byte(`<!doctype html><title>v2</title><script src="/assets/new-hash.js"></script>`)},
		"assets/new-hash.js": &fstest.MapFile{Data: []byte("window.newBuild = true;")},
		"version.json":       &fstest.MapFile{Data: []byte(manifestFor(t, "0.2.0", "stable", "新版"))},
	}
	if previous := a.promote(nextDist, "0.2.0", ""); previous != "0.1.0" {
		t.Fatalf("promote returned previous version %q, want 0.1.0", previous)
	}

	// 新版本立刻在服务：不需要重启，指针换了就是换了。
	rec := doLocal(t, a, http.MethodGet, "/", nil, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "v2") {
		t.Fatalf("after the swap / served %d: %s", rec.Code, rec.Body.String())
	}
	rec = doLocal(t, a, http.MethodGet, "/assets/new-hash.js", nil, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "newBuild") {
		t.Fatalf("the new asset is not served: %d %s", rec.Code, rec.Body.String())
	}

	// 已经打开的标签页还拿着旧 HTML，它引用的 hash 资源只存在于上一份 dist。
	rec = doLocal(t, a, http.MethodGet, "/assets/old-hash.js", nil, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "oldBuild") {
		t.Fatalf("the previous build's asset must keep resolving, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Fatalf("hashed assets must stay immutable, got %q", got)
	}

	// 两份里都没有的资源仍然是 404，回退不是「什么都返回 200」。
	rec = doLocal(t, a, http.MethodGet, "/assets/gone.js", nil, "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "not_found") {
		t.Fatalf("a missing asset returned %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateApplyPromotesStagedDirectory(t *testing.T) {
	a := newUpdateApp(t, fstest.MapFS{
		"index.html":         &fstest.MapFile{Data: []byte("<!doctype html><title>embedded</title>")},
		"assets/embedded.js": &fstest.MapFile{Data: []byte("window.embedded = true;")},
	}, nil)
	a.mu.Lock()
	a.activeVersion = "0.1.0"
	a.mu.Unlock()

	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "index.html"),
		`<!doctype html><title>staged</title><script src="/assets/staged.js"></script>`)
	writeTestFile(t, filepath.Join(dir, "assets", "staged.js"), "window.staged = true;")
	writeTestFile(t, filepath.Join(dir, "version.json"), manifestFor(t, "0.2.0", "beta", "暂存构建"))

	payload, err := json.Marshal(map[string]string{"dir": dir})
	if err != nil {
		t.Fatal(err)
	}
	rec := doLocal(t, a, http.MethodPost, "/__pp/update/apply", bytes.NewReader(payload), "application/json")
	if rec.Code != http.StatusOK {
		t.Fatalf("apply returned %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		OK       bool   `json:"ok"`
		Version  string `json:"version"`
		Previous string `json:"previous"`
		Active   string `json:"active"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("apply response is not JSON: %v (%s)", err, rec.Body.String())
	}
	if !body.OK || body.Version != "0.2.0" || body.Previous != "0.1.0" || body.Active != dir {
		t.Fatalf("unexpected apply response: %+v", body)
	}

	// 换版之后新站点在服务，旧构建的资源也还能取到（旧标签页需要）。
	rec = doLocal(t, a, http.MethodGet, "/", nil, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "staged") {
		t.Fatalf("the staged build is not served: %d %s", rec.Code, rec.Body.String())
	}
	rec = doLocal(t, a, http.MethodGet, "/assets/staged.js", nil, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "staged = true") {
		t.Fatalf("the staged asset is not served: %d %s", rec.Code, rec.Body.String())
	}
	rec = doLocal(t, a, http.MethodGet, "/assets/embedded.js", nil, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "embedded") {
		t.Fatalf("the previous build's asset must keep resolving: %d %s", rec.Code, rec.Body.String())
	}

	// 同一个目录再启用一次：409，不能把「已经在用的目录」再切一遍。
	rec = doLocal(t, a, http.MethodPost, "/__pp/update/apply", bytes.NewReader(payload), "application/json")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "already_active") {
		t.Fatalf("re-applying the active directory returned %d: %s", rec.Code, rec.Body.String())
	}

	// 换版之后「检查更新 → 本站」也要看到新版本：local 读的必须是当前 dist。
	rec = doLocal(t, a, http.MethodGet, "/__pp/update?source=%2Fversion.json", nil, "")
	check := decodeCheck(t, rec)
	if check.Local == nil || check.Local.Version != "0.2.0" {
		t.Fatalf("the local manifest did not follow the swap: %+v", check.Local)
	}
}

func TestUpdateApplyRejectsBadDirectories(t *testing.T) {
	a := newUpdateApp(t, distWithManifest(t, "0.1.0", "stable"), nil)

	noVersion := t.TempDir()
	writeTestFile(t, filepath.Join(noVersion, "index.html"), "<!doctype html><title>no manifest</title>")

	noIndex := t.TempDir()
	writeTestFile(t, filepath.Join(noIndex, "version.json"), manifestFor(t, "0.2.0", "stable", "没有入口"))

	invalidVersion := t.TempDir()
	writeTestFile(t, filepath.Join(invalidVersion, "index.html"), "<!doctype html><title>bad manifest</title>")
	writeTestFile(t, filepath.Join(invalidVersion, "version.json"), `{"title":"T"}`)

	good := t.TempDir()
	writeTestFile(t, filepath.Join(good, "index.html"), "<!doctype html><title>good</title>")
	writeTestFile(t, filepath.Join(good, "version.json"), manifestFor(t, "0.2.0", "stable", "好构建"))

	dirBody := func(dir string) []byte {
		payload, err := json.Marshal(map[string]string{"dir": dir})
		if err != nil {
			t.Fatal(err)
		}
		return payload
	}

	cases := []struct {
		name   string
		body   []byte
		header string
		want   int
		code   string
	}{
		{"directory without version.json", dirBody(noVersion), "application/json", http.StatusBadRequest, "validation_failed"},
		{"directory without index.html", dirBody(noIndex), "application/json", http.StatusBadRequest, "validation_failed"},
		{"invalid version.json", dirBody(invalidVersion), "application/json", http.StatusBadRequest, "validation_failed"},
		{"relative directory", []byte(`{"dir":"build"}`), "application/json", http.StatusBadRequest, "validation_failed"},
		{"blank directory", []byte(`{"dir":"   "}`), "application/json", http.StatusBadRequest, "validation_failed"},
		{"missing directory", dirBody(filepath.Join(t.TempDir(), "build")), "application/json", http.StatusBadRequest, "validation_failed"},
		{"path is a file", dirBody(filepath.Join(good, "version.json")), "application/json", http.StatusBadRequest, "validation_failed"},
		{"broken json", []byte(`{"dir":`), "application/json", http.StatusBadRequest, "validation_failed"},
		{"wrong content type", dirBody(good), "text/plain", http.StatusUnsupportedMediaType, "unsupported_media_type"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doLocal(t, a, http.MethodPost, "/__pp/update/apply", bytes.NewReader(tc.body), tc.header)
			if rec.Code != tc.want || !strings.Contains(rec.Body.String(), tc.code) {
				t.Fatalf("apply returned %d, want %d with %s: %s", rec.Code, tc.want, tc.code, rec.Body.String())
			}
		})
	}

	// 失败之后站点必须还是原来那份，不能被半截请求换掉。
	rec := doLocal(t, a, http.MethodGet, "/", nil, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "test") {
		t.Fatalf("a rejected apply changed the active dist: %d %s", rec.Code, rec.Body.String())
	}

	// 非本机 Host 一律拒绝：这个接口能换掉站点文件，比检查更新更敏感。
	req := httptest.NewRequest(http.MethodPost, "http://press.example.com/__pp/update/apply", bytes.NewReader(dirBody(good)))
	req.Host = "press.example.com"
	req.RemoteAddr = "127.0.0.1:50000"
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "permission_denied") {
		t.Fatalf("public host apply returned %d: %s", rec.Code, rec.Body.String())
	}

	// 非 POST 也不接受。
	rec = doLocal(t, a, http.MethodGet, "/__pp/update/apply", nil, "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET apply returned %d, want 405: %s", rec.Code, rec.Body.String())
	}
}
