package ginrouter_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/plugins"
	ginrouter "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin"
)

// TestPluginHostMountsRoutes proves the transport seam: a wired host adds the
// boot manifest, the plugin API and the bundle route without touching the base
// contract parity (which runs with Plugins nil).
func TestPluginHostMountsRoutes(t *testing.T) {
	host, err := plugins.New(plugins.Options{HostVersion: "0.1.0", ContractVersion: "1.0.0"})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, host.Close()) })

	pluginDir := filepath.Join("..", "..", "..", "plugins", "testdata", "hello")
	_, err = host.Install(pluginDir)
	require.NoError(t, err)
	_, err = host.Enable("com.example.hello")
	require.NoError(t, err)

	engine := ginrouter.New(ginrouter.Dependencies{
		Config:  config.Config{AppEnv: config.EnvTest},
		Plugins: host,
	})

	get := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		engine.ServeHTTP(recorder, request)
		return recorder
	}

	manifest := get("/api/v1/plugins")
	require.Equal(t, http.StatusOK, manifest.Code)
	var boot struct {
		Plugins []plugins.PublicPlugin `json:"plugins"`
	}
	require.NoError(t, json.Unmarshal(manifest.Body.Bytes(), &boot))
	require.Len(t, boot.Plugins, 1)
	require.Equal(t, "com.example.hello", boot.Plugins[0].ID)

	hello := get("/api/v1/plugins/com.example.hello/hello")
	require.Equal(t, http.StatusOK, hello.Code)
	require.Contains(t, hello.Body.String(), "hello from com.example.hello")

	asset := get("/plugins/com.example.hello/1.0.0/client.js")
	require.Equal(t, http.StatusOK, asset.Code)
	require.Contains(t, asset.Body.String(), "__PP_PLUGIN_REGISTER__")

	contract := get("/api/v1/openapi.json")
	require.Equal(t, http.StatusOK, contract.Code)
	require.Contains(t, contract.Body.String(), "/plugins/com.example.hello/hello")
	require.Contains(t, contract.Body.String(), "/plugins/com.example.hello/admin/ping")

	admin := get("/api/v1/plugins/com.example.hello/admin/ping")
	require.Equal(t, http.StatusUnauthorized, admin.Code)
}
