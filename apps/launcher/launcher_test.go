package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
)

func TestNormalizeMode(t *testing.T) {
	cases := map[string]string{
		"":        modeAuto,
		"auto":    modeAuto,
		"demo":    modeDemo,
		"static":  modeDemo,
		"live":    modeLive,
		"REAL":    modeLive,
		"  live ": modeLive,
	}
	for raw, want := range cases {
		got, err := normalizeMode(raw)
		if err != nil {
			t.Fatalf("normalizeMode(%q) returned an error: %v", raw, err)
		}
		if got != want {
			t.Fatalf("normalizeMode(%q) = %q, want %q", raw, got, want)
		}
	}
	if _, err := normalizeMode("cloud"); err == nil {
		t.Fatal("an unknown mode must be rejected")
	}
}

func TestDefaultPortIs8080(t *testing.T) {
	// 用户需求：站点默认开放 8080。改动这个常量会改变所有新安装的首次启动行为。
	if defaultPort != 8080 {
		t.Fatalf("defaultPort = %d, want 8080", defaultPort)
	}
}

func TestCandidatePortsPrefer8080ThenNeighbours(t *testing.T) {
	cases := []struct {
		preferred int
		want      []int
	}{
		// 全新安装：先 8080，占用时依次 8081、8082，最后才退回标准 HTTP 80。
		{8080, []int{8080, 8081, 8082, 80}},
		// 老安装保存过 80：首选端口仍然是用户自己的选择。
		{80, []int{80, 8080, 8081, 8082}},
		// 显式 --port 9000：不要被默认端口顶掉。
		{9000, []int{9000, 8080, 8081, 8082, 80}},
	}
	for _, tc := range cases {
		if got := candidatePorts(tc.preferred); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("candidatePorts(%d) = %v, want %v", tc.preferred, got, tc.want)
		}
	}
}

func TestOriginForPortOmitsOnlyStandardHTTPPort(t *testing.T) {
	if got := originForPort(8080); got != "http://localhost:8080" {
		t.Fatalf("originForPort(8080) = %q, want http://localhost:8080", got)
	}
	// 80 是浏览器默认端口，地址栏不写端口号；这是 URL 语义，与站点默认端口无关。
	if got := originForPort(80); got != "http://localhost" {
		t.Fatalf("originForPort(80) = %q, want http://localhost", got)
	}
}

func TestIsAPIPath(t *testing.T) {
	for _, path := range []string{
		"/api", "/api/", "/api/v1/articles", "/healthz", "/readyz",
		"/sitemap.xml", "/robots.txt",
		"/rss.xml", "/atom.xml", "/feed.xml",
		"/category/news/rss.xml", "/category/news/atom.xml",
		"/tag/go/rss.xml", "/tag/go/atom.xml",
		"/plugins/com.example.hello/1.0.0/client.js",
	} {
		if !isAPIPath(path) {
			t.Fatalf("%s must be proxied to the API", path)
		}
	}
	for _, path := range []string{"/", "/admin", "/apix", "/plugins", "/__pp/runtime", "/assets/app.js", "/sitemap.xml.bak", "/robots.txt/extra", "/category/news", "/tag/go", "/category/news/extra.xml"} {
		if isAPIPath(path) {
			t.Fatalf("%s must be served by the launcher itself", path)
		}
	}
}

func TestSQLiteDSNEscapesSpacesAndPragmas(t *testing.T) {
	dsn := sqliteDSN(`C:\Users\Some One\Practacu Press\data\practacu.db`)
	if !strings.HasPrefix(dsn, "file:C:/Users/Some%20One/Practacu%20Press/data/practacu.db?") {
		t.Fatalf("unexpected dsn: %s", dsn)
	}
	if !strings.Contains(dsn, "_pragma=journal_mode(WAL)") {
		t.Fatalf("WAL pragma missing: %s", dsn)
	}
}

func TestReadWriteStateRoundTrip(t *testing.T) {
	file := filepath.Join(t.TempDir(), "practacu-web.json")
	if err := writeState(file, launcherState{Port: 8090, JWTKey: "abc"}); err != nil {
		t.Fatalf("writeState: %v", err)
	}

	state := readState(file)
	if state.Port != 8090 || state.JWTKey != "abc" {
		t.Fatalf("unexpected state: %+v", state)
	}

	// A corrupt file must not stop the launcher.
	if err := os.WriteFile(file, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if state := readState(file); state.Port != 0 || state.JWTKey != "" {
		t.Fatalf("corrupt state must read as empty, got %+v", state)
	}

	// An out of range port is ignored rather than bound to.
	payload, _ := json.Marshal(map[string]any{"port": 99999})
	if err := os.WriteFile(file, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	if state := readState(file); state.Port != 0 {
		t.Fatalf("out of range port must be dropped, got %d", state.Port)
	}
}

func TestEnsureSigningKeyIsStable(t *testing.T) {
	file := filepath.Join(t.TempDir(), "practacu-web.json")
	state := readState(file)

	first, err := ensureSigningKey(file, &state)
	if err != nil {
		t.Fatalf("ensureSigningKey: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(first)
	if err != nil {
		t.Fatalf("key is not base64: %v", err)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(raw)
	if err != nil {
		t.Fatalf("key is not PKCS#8: %v", err)
	}
	if _, ok := parsed.(ed25519.PrivateKey); !ok {
		t.Fatalf("unexpected key type %T", parsed)
	}

	// The key must survive a restart, otherwise every launch logs the operator out.
	reloaded := readState(file)
	second, err := ensureSigningKey(file, &reloaded)
	if err != nil {
		t.Fatalf("ensureSigningKey (reload): %v", err)
	}
	if first != second {
		t.Fatal("the signing key must be reused across launches")
	}
}

func TestProxyKeepsBrowserHostAndForwardsPath(t *testing.T) {
	var gotHost, gotPath, gotProto string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotPath = r.URL.Path
		gotProto = r.Header.Get("X-Forwarded-Proto")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer upstream.Close()

	base, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := newAPIProxy(base)

	req := httptest.NewRequest(http.MethodGet, "http://localhost/api/v1/articles", nil)
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != `{"status":"ok"}` {
		t.Fatalf("unexpected proxy response: %d %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/api/v1/articles" {
		t.Fatalf("path was rewritten to %q", gotPath)
	}
	if gotHost != "localhost" {
		t.Fatalf("the browser host must reach the API unchanged, got %q", gotHost)
	}
	if gotProto != "http" {
		t.Fatalf("X-Forwarded-Proto missing, got %q", gotProto)
	}
}

func TestStartLiveRejectsMissingBinary(t *testing.T) {
	_, err := startLive(liveOptions{apiBinary: "", dataDir: t.TempDir()})
	if err == nil {
		t.Fatal("startLive must fail without an API binary")
	}
}

// newTestApp builds the smallest app the HTTP handlers need: an embedded-like
// static site and empty runtime state. It never binds a socket.
func newTestApp(t *testing.T) *app {
	t.Helper()
	return &app{
		dist: fstest.MapFS{
			"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>test</title>")},
		},
		distReady: true,
		stateFile: filepath.Join(t.TempDir(), stateName),
		snapshots: map[string]snapshot{},
		mode:      modeDemo,
		port:      18099,
	}
}

func TestIsLoopbackHost(t *testing.T) {
	loopback := []string{
		"localhost",
		"localhost:80",
		"LOCALHOST:8080",
		"localhost.",
		"127.0.0.1",
		"127.0.0.1:18099",
		"127.0.0.2:9000",
		"[::1]",
		"[::1]:18099",
		"::1",
	}
	for _, host := range loopback {
		if !isLoopbackHost(host) {
			t.Fatalf("isLoopbackHost(%q) = false, want true", host)
		}
	}
	notLoopback := []string{
		"",
		"example.com",
		"example.com:80",
		"192.168.1.10:18099",
		"10.0.0.5",
		"[2001:db8::1]:443",
		"evil.example:8080",
	}
	for _, host := range notLoopback {
		if isLoopbackHost(host) {
			t.Fatalf("isLoopbackHost(%q) = true, want false", host)
		}
	}
}

func TestControlPlaneRejectsProxiedPublicRequests(t *testing.T) {
	a := newTestApp(t)
	token := strings.Repeat("a", 32)
	cases := []struct {
		name   string
		method string
		path   string
		host   string
		remote string
		body   string
	}{
		{"runtime via public host", http.MethodGet, "/__pp/runtime", "press.example.com:8080", "127.0.0.1:50000", ""},
		{"port via public host", http.MethodPost, "/__pp/runtime/port", "press.example.com", "127.0.0.1:50000", `{"port":18099}`},
		{"state via public host", http.MethodGet, "/__pp/state/" + token, "192.168.1.10:18099", "127.0.0.1:50000", ""},
		{"runtime from a remote peer", http.MethodGet, "/__pp/runtime", "127.0.0.1:18099", "203.0.113.7:50000", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "http://"+tc.host+tc.path, strings.NewReader(tc.body))
			req.Host = tc.host
			req.RemoteAddr = tc.remote
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			a.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("%s returned %d, want 403 (body: %s)", tc.name, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"permission_denied"`) {
				t.Fatalf("%s body does not name permission_denied: %s", tc.name, rec.Body.String())
			}
		})
	}
}

func TestControlPlaneRejectsForwardedRequests(t *testing.T) {
	a := newTestApp(t)
	// A proxy that rewrites Host to 127.0.0.1 would look local; the forwarding
	// headers it adds are what still gives it away.
	for _, header := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP", "Forwarded"} {
		t.Run(header, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18099/__pp/runtime", nil)
			req.Host = "127.0.0.1:18099"
			req.RemoteAddr = "127.0.0.1:50000"
			req.Header.Set(header, "203.0.113.7")
			rec := httptest.NewRecorder()
			a.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("forwarded request with %s returned %d, want 403: %s", header, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestRuntimeResponseOmitsInternalDetails(t *testing.T) {
	a := newTestApp(t)
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18099/__pp/runtime", nil)
	req.Host = "127.0.0.1:18099"
	req.RemoteAddr = "127.0.0.1:50000"
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("runtime returned %d: %s", rec.Code, rec.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("runtime is not JSON: %v", err)
	}
	for _, field := range []string{"mode", "runtime_mode", "name", "port", "origin", "dist_ready", "api"} {
		if _, ok := body[field]; !ok {
			t.Fatalf("runtime lost the field %q the page needs: %v", field, body)
		}
	}
	for _, field := range []string{"pid", "started_at"} {
		if _, ok := body[field]; ok {
			t.Fatalf("runtime still leaks %q: %v", field, body)
		}
	}

	api, ok := body["api"].(map[string]any)
	if !ok {
		t.Fatalf("runtime api is not an object: %v", body["api"])
	}
	for _, field := range []string{"base", "data_dir", "log", "pid"} {
		if _, ok := api[field]; ok {
			t.Fatalf("runtime api still leaks %q: %v", field, api)
		}
	}
	for _, field := range []string{"managed", "ready"} {
		if _, ok := api[field]; !ok {
			t.Fatalf("runtime api lost %q: %v", field, api)
		}
	}
}

func TestRuntimeAndStateAcceptLoopbackHost(t *testing.T) {
	a := newTestApp(t)
	token := strings.Repeat("b", 32)

	runtimeReq := httptest.NewRequest(http.MethodGet, "http://localhost:18099/__pp/runtime", nil)
	runtimeReq.Host = "localhost:18099"
	runtimeReq.RemoteAddr = "127.0.0.1:50000"
	runtimeRec := httptest.NewRecorder()
	a.ServeHTTP(runtimeRec, runtimeReq)
	if runtimeRec.Code != http.StatusOK {
		t.Fatalf("localhost must reach the runtime endpoint, got %d: %s", runtimeRec.Code, runtimeRec.Body.String())
	}

	// A loopback Host with no Origin header (curl/scripts) must still be allowed.
	portReq := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:18099/__pp/runtime/port", strings.NewReader(`{"port":18099}`))
	portReq.Host = "127.0.0.1:18099"
	portReq.RemoteAddr = "127.0.0.1:50000"
	portReq.Header.Set("Content-Type", "application/json")
	portRec := httptest.NewRecorder()
	a.ServeHTTP(portRec, portReq)
	if portRec.Code != http.StatusOK {
		t.Fatalf("loopback port change returned %d: %s", portRec.Code, portRec.Body.String())
	}

	// An unknown token must be a plain 404, not an auth failure.
	stateReq := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18099/__pp/state/"+token, nil)
	stateReq.Host = "127.0.0.1:18099"
	stateReq.RemoteAddr = "127.0.0.1:50000"
	stateRec := httptest.NewRecorder()
	a.ServeHTTP(stateRec, stateReq)
	if stateRec.Code != http.StatusNotFound {
		t.Fatalf("unknown import token returned %d, want 404: %s", stateRec.Code, stateRec.Body.String())
	}
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	a := newTestApp(t)
	headers := map[string]string{
		"Content-Security-Policy": contentSecurityPolicy,
		"X-Frame-Options":         "SAMEORIGIN",
		"Referrer-Policy":         "strict-origin-when-cross-origin",
		"Permissions-Policy":      "camera=(), microphone=(), geolocation=()",
		"X-Content-Type-Options":  "nosniff",
	}
	for _, target := range []string{"/", "/__pp/runtime", "/__pp/unknown", "/api/v1/articles", "/healthz"} {
		req := httptest.NewRequest(http.MethodGet, "http://localhost:18099"+target, nil)
		req.Host = "localhost:18099"
		req.RemoteAddr = "127.0.0.1:50000"
		rec := httptest.NewRecorder()
		a.ServeHTTP(rec, req)
		for name, want := range headers {
			if got := rec.Header().Get(name); got != want {
				t.Fatalf("%s: header %s = %q, want %q", target, name, got, want)
			}
		}
	}
}

// cspSources splits a policy into directive name → source list, the way a browser
// reads it: directives are separated by `;`, sources by whitespace.
func cspSources(policy string) map[string][]string {
	out := map[string][]string{}
	for _, directive := range strings.Split(policy, ";") {
		fields := strings.Fields(directive)
		if len(fields) == 0 {
			continue
		}
		out[fields[0]] = fields[1:]
	}
	return out
}

// TestContentSecurityPolicyKeepsTheEditorPreviewFrameable is a regression test for the
// page builder showing the browser's own "this content is blocked" page in place of the
// preview. The policy used to set `frame-src` to the three captcha providers only, so
// the same-origin preview iframe — and every authored iframe in a "website" block —
// was refused by the browser before the request was ever made.
func TestContentSecurityPolicyKeepsTheEditorPreviewFrameable(t *testing.T) {
	directives := cspSources(contentSecurityPolicy)

	frameSrc, ok := directives["frame-src"]
	if !ok {
		t.Fatal("the policy has no frame-src directive; the editor preview would then depend on default-src")
	}
	allowed := map[string]bool{}
	for _, source := range frameSrc {
		allowed[source] = true
	}

	// apps/web/src/components/builder/PreviewFrame.tsx loads the real front end from this
	// origin. Without 'self' the browser refuses the frame and the editor looks broken.
	if !allowed["'self'"] {
		t.Fatalf("frame-src = %v, want 'self' so the page builder can preview the site", frameSrc)
	}
	// The "website" block embeds a URL the author typed: https in production, plain http
	// on a loopback install whose own origin is http.
	for _, scheme := range []string{"https:", "http:"} {
		if !allowed[scheme] {
			t.Fatalf("frame-src = %v, want %s for the website block's iframe mode", frameSrc, scheme)
		}
	}

	// The point of the header is anti-framing, so keep that half pinned.
	if got := directives["frame-ancestors"]; !reflect.DeepEqual(got, []string{"'self'"}) {
		t.Fatalf("frame-ancestors = %v, want [\"'self'\"]", got)
	}

	// The bundler inlines the small KaTeX faces as data URIs; without this the maths
	// fonts in an article are refused and fall back to the system font.
	fonts := map[string]bool{}
	for _, source := range directives["font-src"] {
		fonts[source] = true
	}
	if !fonts["'self'"] || !fonts["data:"] {
		t.Fatalf("font-src = %v, want 'self' and data: for the bundled maths fonts", directives["font-src"])
	}
}

func TestSealAndOpenSecretRoundTrip(t *testing.T) {
	secret := []byte("a signing key that must not be readable on disk")
	sealed, err := sealSecret(secret)
	if err != nil {
		t.Fatalf("sealSecret: %v", err)
	}
	if runtime.GOOS == "windows" && !isSealedSecret(sealed) {
		t.Fatalf("Windows must seal the secret, got %q", sealed)
	}
	if runtime.GOOS != "windows" && isSealedSecret(sealed) {
		t.Fatalf("non-Windows must not pretend to seal the secret, got %q", sealed)
	}

	opened, err := openSecret(sealed)
	if err != nil {
		t.Fatalf("openSecret: %v", err)
	}
	if string(opened) != string(secret) {
		t.Fatalf("round trip changed the secret: %q", opened)
	}

	// Various payload sizes, so an incorrect DPAPI buffer length or an early free
	// shows up as a mismatch instead of working by accident on one small value.
	for _, size := range []int{1, 16, 48, 64, 200, 1024} {
		payload := make([]byte, size)
		for i := range payload {
			payload[i] = byte(i*7 + size)
		}
		sealed, err := sealSecret(payload)
		if err != nil {
			t.Fatalf("sealSecret(%d bytes): %v", size, err)
		}
		opened, err := openSecret(sealed)
		if err != nil {
			t.Fatalf("openSecret(%d bytes): %v", size, err)
		}
		if !bytes.Equal(opened, payload) {
			t.Fatalf("round trip changed a %d byte secret", size)
		}
	}

	for _, broken := range []string{"", "not base64!!", sealedSecretPrefix + "!!!", sealedSecretPrefix} {
		if _, err := openSecret(broken); err == nil {
			t.Fatalf("openSecret(%q) must fail", broken)
		}
	}
}

func TestWriteStateSealsTheSigningKey(t *testing.T) {
	file := filepath.Join(t.TempDir(), stateName)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	plain := base64.StdEncoding.EncodeToString(der)

	if err := writeState(file, launcherState{Port: 8090, JWTKey: plain}); err != nil {
		t.Fatalf("writeState: %v", err)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	stored := readState(file)
	if runtime.GOOS == "windows" {
		if !isSealedSecret(stored.JWTKey) {
			t.Fatalf("the signing key was written without DPAPI: %s", raw)
		}
		if strings.Contains(string(raw), plain) {
			t.Fatalf("the state file still contains the plaintext signing key")
		}
	} else if stored.JWTKey != plain {
		t.Fatalf("non-Windows state must keep the plain base64 key, got %q", stored.JWTKey)
	}

	// Writing a sealed state again must not seal it twice.
	if err := writeState(file, stored); err != nil {
		t.Fatalf("writeState (second): %v", err)
	}
	again := readState(file)
	if again.JWTKey != stored.JWTKey {
		t.Fatalf("a second write changed the stored key: %q -> %q", stored.JWTKey, again.JWTKey)
	}
}

func TestEnsureSigningKeyMigratesLegacyPlaintext(t *testing.T) {
	file := filepath.Join(t.TempDir(), stateName)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	plain := base64.StdEncoding.EncodeToString(der)

	// A state file written by an older launcher: jwt_key is plain base64.
	legacy, err := json.Marshal(launcherState{Port: 18099, JWTKey: plain})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, legacy, 0o644); err != nil {
		t.Fatal(err)
	}

	state := readState(file)
	got, err := ensureSigningKey(file, &state)
	if err != nil {
		t.Fatalf("ensureSigningKey: %v", err)
	}
	if got != plain {
		t.Fatal("the legacy key must keep working, otherwise the operator is logged out")
	}

	stored := readState(file)
	if stored.Port != 18099 {
		t.Fatalf("migration lost the port: %d", stored.Port)
	}
	if runtime.GOOS == "windows" && !isSealedSecret(stored.JWTKey) {
		t.Fatal("a Windows launcher must migrate the legacy plaintext key to DPAPI")
	}
	if runtime.GOOS != "windows" && stored.JWTKey != plain {
		t.Fatalf("non-Windows state changed unexpectedly: %q", stored.JWTKey)
	}

	// The migrated file must still yield the same key on the next launch.
	second, err := ensureSigningKey(file, &stored)
	if err != nil {
		t.Fatalf("ensureSigningKey (reload): %v", err)
	}
	if second != plain {
		t.Fatal("the migrated key must survive a restart")
	}
}
