package plugins

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// sharedHost is built once because compiling a 4 MiB Go/WASI module costs a
// few seconds. Every test resets only the state it needs; the timeout test is
// kept in zz_timeout_test.go because it deliberately kills the runtime.
var sharedHost *Host

func TestMain(m *testing.M) {
	host, err := New(Options{HostVersion: "0.1.0", ContractVersion: "1.0.0"})
	if err != nil {
		panic(err)
	}
	if _, err := host.Install(filepath.Join("testdata", "hello")); err != nil {
		panic(err)
	}
	sharedHost = host
	code := m.Run()
	_ = host.Close()
	os.Exit(code)
}

func enableHello(t *testing.T) {
	t.Helper()
	_, err := sharedHost.Enable("com.example.hello")
	require.NoError(t, err)
}

func TestLifecycleInstallEnableDisableRemove(t *testing.T) {
	enableHello(t)
	public := sharedHost.PublicPlugins()
	require.Len(t, public, 1)
	require.Equal(t, "com.example.hello", public[0].ID)
	require.Equal(t, "1.0.0", public[0].Version)
	require.Contains(t, public[0].Entry, "/plugins/com.example.hello/1.0.0/client.js")
	require.Contains(t, public[0].Slots, "article.after")

	_, err := sharedHost.Disable("com.example.hello")
	require.NoError(t, err)
	require.Empty(t, sharedHost.PublicPlugins())

	status, ok := sharedHost.Get("com.example.hello")
	require.True(t, ok)
	require.Equal(t, StateDisabled, status.State)

	// Leave it enabled for the tests that follow.
	enableHello(t)
}

func TestInstallRejectsDuplicatePlugin(t *testing.T) {
	_, err := sharedHost.Install(filepath.Join("testdata", "hello"))
	require.ErrorContains(t, err, "already installed")
}

func TestInstallRejectsIncompatibleHost(t *testing.T) {
	host, err := New(Options{HostVersion: "0.0.1"})
	require.NoError(t, err)
	defer host.Close()
	_, err = host.Install(filepath.Join("testdata", "hello"))
	require.Error(t, err)
	require.Contains(t, err.Error(), "requires host")
}

func TestTransformHTMLRunsTheSandboxedHook(t *testing.T) {
	enableHello(t)
	html, results := sharedHost.TransformHTML(context.Background(), HookPayload{
		HTML:   "<p>body</p>",
		SiteID: "site_1",
		Kind:   "article",
	})
	require.Contains(t, html, "<p>body</p>")
	require.Contains(t, html, `data-pp-plugin="com.example.hello"`)
	require.Contains(t, html, `data-pp-site="site_1"`)
	require.Len(t, results, 1)
	require.NoError(t, results[0].Error)
}

func TestPluginHTTPRouteIsServed(t *testing.T) {
	enableHello(t)
	handler := sharedHost.APIHandler("/api/v1/plugins/")
	request := httptest.NewRequest(http.MethodGet, "/api/v1/plugins/com.example.hello/hello", nil)
	request = request.WithContext(WithRequestInfo(request.Context(), RequestInfo{SiteID: "site_42"}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "application/json", recorder.Header().Get("Content-Type"))
	var body map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Equal(t, "hello from com.example.hello", body["message"])
	require.Equal(t, "site_42", body["site_id"])
}

func TestPluginRouteAuthIsEnforcedBeforeTheSandbox(t *testing.T) {
	enableHello(t)
	handler := sharedHost.APIHandler("/api/v1/plugins/")

	call := func(info RequestInfo) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/plugins/com.example.hello/admin/ping", nil)
		request = request.WithContext(WithRequestInfo(request.Context(), info))
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}

	require.Equal(t, http.StatusUnauthorized, call(RequestInfo{Authenticated: false}).Code)
	require.Equal(t, http.StatusForbidden, call(RequestInfo{Authenticated: true, Role: "member"}).Code)
	admin := call(RequestInfo{Authenticated: true, Role: "site_admin", UserID: "user_1"})
	require.Equal(t, http.StatusOK, admin.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(admin.Body.Bytes(), &body))
	require.Equal(t, "site_admin", body["role"])
}

func TestAssetHandlerServesOnlyTheFrontendDirectory(t *testing.T) {
	enableHello(t)
	handler := sharedHost.AssetHandler("/plugins/")

	get := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder
	}

	ok := get("/plugins/com.example.hello/1.0.0/client.js")
	require.Equal(t, http.StatusOK, ok.Code)
	require.Equal(t, "text/javascript; charset=utf-8", ok.Header().Get("Content-Type"))
	require.NotEmpty(t, ok.Header().Get("ETag"))
	require.Contains(t, ok.Body.String(), "__PP_PLUGIN_REGISTER__")

	require.Equal(t, http.StatusNotFound, get("/plugins/com.example.hello/9.9.9/client.js").Code)
	require.Equal(t, http.StatusNotFound, get("/plugins/com.example.hello/1.0.0/../../plugin.json").Code)
	require.Equal(t, http.StatusNotFound, get("/plugins/com.example.hello/1.0.0/backend/hello.wasm").Code)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/plugins/com.example.hello/1.0.0/client.js", nil)
	request.Header.Set("If-None-Match", ok.Header().Get("ETag"))
	handler.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusNotModified, recorder.Code)
}

func TestContractIncludesEnabledPluginRoutes(t *testing.T) {
	_, err := sharedHost.Disable("com.example.hello")
	require.NoError(t, err)
	base, err := sharedHost.ContractJSON()
	require.NoError(t, err)
	require.NotContains(t, string(base), "/plugins/com.example.hello/hello")

	enableHello(t)
	withPlugin, err := sharedHost.ContractJSON()
	require.NoError(t, err)
	require.Contains(t, string(withPlugin), "/plugins/com.example.hello/hello")
	require.Contains(t, string(withPlugin), `"x-pp-plugins"`)

	var document map[string]any
	require.NoError(t, json.Unmarshal(withPlugin, &document))
	paths, ok := document["paths"].(map[string]any)
	require.True(t, ok)
	operation, ok := paths["/plugins/com.example.hello/hello"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "com.example.hello", operation["tags"].([]any)[0])
}

func TestHostCloseIsIdempotent(t *testing.T) {
	host, err := New(Options{HostVersion: "0.1.0"})
	require.NoError(t, err)
	require.NoError(t, host.Close())
	require.NoError(t, host.Close())
}

func TestInstallReadsTheReferencePluginFiles(t *testing.T) {
	dir := filepath.Join("testdata", "hello")
	_, err := os.Stat(filepath.Join(dir, "backend", "hello.wasm"))
	require.NoError(t, err)
	manifest, err := LoadManifest(dir)
	require.NoError(t, err)
	require.Equal(t, "com.example.hello", manifest.ID)
	require.True(t, strings.HasPrefix(manifest.Engines.PP, ">="))
}
