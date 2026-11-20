package storageadmin

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/media"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
)

type recordingAudit struct {
	entries []audit.Entry
}

func (r *recordingAudit) Record(_ context.Context, entry audit.Entry) error {
	r.entries = append(r.entries, entry)
	return nil
}

func handlerTestRequest(t *testing.T, manager *Manager) UpdateRequest {
	t.Helper()
	return UpdateRequest{
		GlobalStrategyID: "a",
		Strategies: []StrategyInput{{
			ID: "a", Name: "A", Driver: "local", LocalDir: filepath.Join(manager.dataDir, "a"),
		}},
		Scopes: map[string]string{
			config.StorageScopeContent: "a", config.StorageScopeSite: "a",
			config.StorageScopeAvatar: "a", config.StorageScopeAttachment: "a",
		},
		Allocations: map[string]AllocationInput{
			config.StorageScopeContent:    singleInput("a"),
			config.StorageScopeSite:       singleInput("a"),
			config.StorageScopeAvatar:     singleInput("a"),
			config.StorageScopeAttachment: singleInput("a"),
		},
	}
}

func TestStorageHandlerPermissionsAndAudit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	base := t.TempDir()
	manager, err := NewManager(Config{
		Env:     config.Config{StorageDriver: config.StorageDriverLocal, StorageDir: filepath.Join(base, "media")},
		DataDir: base,
		Logger:  testLogger(),
		Build: func(context.Context, Target) (media.Storage, error) {
			return newFakeStore("x"), nil
		},
	})
	require.NoError(t, err)

	recorded := &recordingAudit{}
	handler := NewHandler(manager, HandlerConfig{
		Principal: func(c *gin.Context) (Principal, bool) {
			role := c.GetHeader("X-Test-Role")
			if role == "" {
				return Principal{}, false
			}
			return Principal{UserID: "u1", SiteID: "s1", Role: site.Role(role)}, true
		},
		Audit:  recorded,
		Logger: testLogger(),
	})
	engine := gin.New()
	engine.Use(middleware.RequestID(), middleware.ErrorHandler(testLogger()))
	noop := func(c *gin.Context) { c.Next() }
	handler.Routes(engine.Group("/api/v1"), noop)

	request := func(method, role string, body any) *httptest.ResponseRecorder {
		var reader io.Reader
		if body != nil {
			raw, err := json.Marshal(body)
			require.NoError(t, err)
			reader = bytes.NewReader(raw)
		}
		httpRequest := httptest.NewRequest(method, "/api/v1/system/storage", reader)
		if role != "" {
			httpRequest.Header.Set("X-Test-Role", role)
		}
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, httpRequest)
		return recorder
	}

	require.Equal(t, http.StatusUnauthorized, request(http.MethodGet, "", nil).Code)
	require.Equal(t, http.StatusForbidden, request(http.MethodGet, "viewer", nil).Code)
	get := request(http.MethodGet, "site_admin", nil)
	require.Equal(t, http.StatusOK, get.Code)
	require.Equal(t, "no-store", get.Header().Get("Cache-Control"))
	require.NotContains(t, get.Body.String(), "s3_secret_key")

	payload := handlerTestRequest(t, manager)
	require.Equal(t, http.StatusForbidden, request(http.MethodPut, "site_admin", payload).Code)
	put := request(http.MethodPut, "platform_admin", payload)
	require.Equal(t, http.StatusOK, put.Code, put.Body.String())
	require.Len(t, recorded.entries, 1)
	require.Equal(t, "system.storage.updated", recorded.entries[0].Action)
	require.Equal(t, "deployment", recorded.entries[0].TargetType)
}
