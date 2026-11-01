package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
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

func TestIsAPIPath(t *testing.T) {
	for _, path := range []string{"/api", "/api/", "/api/v1/articles", "/healthz", "/readyz"} {
		if !isAPIPath(path) {
			t.Fatalf("%s must be proxied to the API", path)
		}
	}
	for _, path := range []string{"/", "/admin", "/apix", "/__pp/runtime", "/assets/app.js"} {
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
