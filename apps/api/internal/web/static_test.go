package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"testing/fstest"

	"github.com/gin-gonic/gin"
)

func newStaticEngine(fsys fstest.MapFS) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.NoRoute(func(c *gin.Context) {
		if ServeFS(c, fsys) {
			return
		}
		c.Status(http.StatusNotFound)
	})
	return r
}

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><title>app</title>")},
		"version.json":  {Data: []byte(`{"version":"1.2.3"}`)},
		"theme-boot.js": {Data: []byte("document.documentElement.dataset.theme='dark'")},
		"assets/app-abc.js": {
			Data: []byte("console.log('app')"),
		},
	}
}

func serveRequest(t *testing.T, engine *gin.Engine, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, target, nil)
	engine.ServeHTTP(recorder, request)
	return recorder
}

func TestServeRootAndSpaFallback(t *testing.T) {
	engine := newStaticEngine(testFS())

	for _, target := range []string{"/", "/admin/posts", "/admin/", "/2026/hello-world"} {
		response := serveRequest(t, engine, http.MethodGet, target)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", target, response.Code)
		}
		if body := response.Body.String(); body != "<!doctype html><title>app</title>" {
			t.Fatalf("%s: body = %q", target, body)
		}
		if got := response.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: Cache-Control = %q, want no-cache", target, got)
		}
	}
}

func TestServeAssetsAreImmutable(t *testing.T) {
	engine := newStaticEngine(testFS())

	response := serveRequest(t, engine, http.MethodGet, "/assets/app-abc.js")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != "text/javascript; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("Cache-Control = %q", got)
	}
	if response.Body.String() != "console.log('app')" {
		t.Errorf("body = %q", response.Body.String())
	}
}

func TestServeRejectsApiAndMissingFiles(t *testing.T) {
	engine := newStaticEngine(testFS())

	for _, target := range []string{
		"/api/v1/nope",
		"/api",
		"/healthz/nope",
		"/readyz",
		"/plugins/nope.js",
		"/__pp/state",
		"/missing.js",
		"/assets/missing.js",
		"/assets/",
	} {
		response := serveRequest(t, engine, http.MethodGet, target)
		if response.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", target, response.Code)
		}
		if body := response.Body.String(); body == "<!doctype html><title>app</title>" {
			t.Errorf("%s: fell back to the SPA", target)
		}
	}
}

func TestServeRejectsTraversal(t *testing.T) {
	engine := newStaticEngine(testFS())

	recorder := httptest.NewRecorder()
	request := &http.Request{
		Method: http.MethodGet,
		URL:    &url.URL{Path: "/../etc/passwd"},
	}
	engine.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
}

func TestServeHeadHasNoBody(t *testing.T) {
	engine := newStaticEngine(testFS())

	response := serveRequest(t, engine, http.MethodHead, "/")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if response.Body.Len() != 0 {
		t.Fatalf("HEAD body = %q, want empty", response.Body.String())
	}
}

func TestServeWithoutFrontendDoesNotInventAnIndex(t *testing.T) {
	engine := newStaticEngine(fstest.MapFS{
		"version.json": {Data: []byte(`{"version":"0"}`)},
	})

	response := serveRequest(t, engine, http.MethodGet, "/")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for an API-only build", response.Code)
	}
}
