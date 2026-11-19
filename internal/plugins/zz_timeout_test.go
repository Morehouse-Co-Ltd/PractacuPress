package plugins

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestPluginRouteTimesOut must run after every other shared-host test: it
// deliberately closes the reference plugin's runtime to prove that a WASI
// sleep cannot hold a request past its deadline.
func TestPluginRouteTimesOut(t *testing.T) {
	enableHello(t)
	handler := sharedHost.APIHandler("/api/v1/plugins/")
	request := httptest.NewRequest(http.MethodGet, "/api/v1/plugins/com.example.hello/hello?sleep=1", nil)
	recorder := httptest.NewRecorder()

	started := time.Now()
	handler.ServeHTTP(recorder, request)
	elapsed := time.Since(started)

	require.Equal(t, http.StatusBadGateway, recorder.Code)
	require.Less(t, elapsed, 2*time.Second, "the host must cancel the invocation, not wait for the plugin")

	// The timeout closes the plugin's runtime. A later request must rebuild it from
	// the retained wasm bytes instead of failing with "runtime closed" forever.
	recovered := httptest.NewRecorder()
	handler.ServeHTTP(recovered, httptest.NewRequest(http.MethodGet, "/api/v1/plugins/com.example.hello/hello", nil))
	require.Equal(t, http.StatusOK, recovered.Code,
		"a timed-out plugin must be rebuilt on the next call: %s", recovered.Body.String())
}
