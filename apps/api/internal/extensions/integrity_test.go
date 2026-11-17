package extensions

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	"github.com/practacu/practacu-press/apps/api/internal/plugins"
	ginmiddleware "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// fakeAudit collects audit entries. It is concurrency safe because the manager
// records from whichever goroutine loaded a package.
type fakeAudit struct {
	mu      sync.Mutex
	entries []audit.Entry
}

func (f *fakeAudit) Record(_ context.Context, entry audit.Entry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entries = append(f.entries, entry)
	return nil
}

func (f *fakeAudit) actions() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.entries))
	for _, entry := range f.entries {
		out = append(out, entry.Action)
	}
	return out
}

func (f *fakeAudit) last(t *testing.T) audit.Entry {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(t, f.entries)
	return f.entries[len(f.entries)-1]
}

// importFrontendPackage imports one browser-only package into a fresh data dir.
func importFrontendPackage(t *testing.T, manager *Manager) Extension {
	t.Helper()
	source := filepath.Join(t.TempDir(), "package")
	writeFrontendPackage(t, source, "com.example.frontend", "1.0.0")
	imported, err := manager.ImportZip(bytes.NewReader(zipTree(t, source)), 0)
	require.NoError(t, err)
	return imported
}

// TestImportRecordsVerifiedIntegrity covers the install side of contract D.
func TestImportRecordsVerifiedIntegrity(t *testing.T) {
	dataDir := t.TempDir()
	manager := newTestManager(t, dataDir, nil)

	imported := importFrontendPackage(t, manager)
	require.Equal(t, string(plugins.IntegrityVerified), imported.Integrity)
	require.Len(t, imported.ManifestHash, 64)
	require.NotEmpty(t, imported.VerifiedAt)
	require.FileExists(t,
		filepath.Join(dataDir, "extensions", "com.example.frontend", plugins.ManifestSidecarName))

	// A restart reads the sidecar back and reports the same state.
	restarted := newTestManager(t, dataDir, nil)
	items, err := restarted.List()
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, string(plugins.IntegrityVerified), items[0].Integrity)
	require.Equal(t, imported.ManifestHash, items[0].ManifestHash)
	require.Equal(t, imported.VerifiedAt, items[0].VerifiedAt)
}

// TestMissingSidecarIsUnsigned proves a package without a recorded digest is
// reported, not rejected: existing installations must keep working.
func TestMissingSidecarIsUnsigned(t *testing.T) {
	dataDir := t.TempDir()
	manager := newTestManager(t, dataDir, nil)
	imported := importFrontendPackage(t, manager)

	require.NoError(t, os.Remove(
		filepath.Join(dataDir, "extensions", "com.example.frontend", plugins.ManifestSidecarName)))

	items, err := manager.List()
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, string(plugins.IntegrityUnsigned), items[0].Integrity)
	require.Len(t, items[0].ManifestHash, 64)
	require.Empty(t, items[0].VerifiedAt)

	// Unsigned is an informational state: enabling still works.
	enabled, err := manager.SetEnabled(imported.ID, true)
	require.NoError(t, err)
	require.True(t, enabled.Enabled)
}

// TestTamperedManifestIsRefused is the security property: a manifest edited
// after install cannot be enabled and the refusal is persisted.
func TestTamperedManifestIsRefused(t *testing.T) {
	dataDir := t.TempDir()
	manager := newTestManager(t, dataDir, nil)
	imported := importFrontendPackage(t, manager)
	require.True(t, imported.Enabled)

	manifestPath := filepath.Join(dataDir, "extensions", "com.example.frontend", plugins.ManifestFileName)
	raw, err := os.ReadFile(manifestPath)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(manifestPath, append(raw, '\n'), 0o644))

	items, err := manager.List()
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, string(plugins.IntegrityMismatch), items[0].Integrity)
	require.Equal(t, imported.ManifestHash, items[0].ManifestHash, "the recorded digest is still reported")

	_, err = manager.SetEnabled(imported.ID, true)
	require.ErrorIs(t, err, plugins.ErrIntegrityMismatch)

	// The host marked the package failed and the disabled decision was persisted.
	status, ok := manager.Host().Get(imported.ID)
	require.True(t, ok)
	require.Equal(t, plugins.StateFailed, status.State)
	require.NotEmpty(t, status.LastError)
	require.False(t, readStateDocument(t, dataDir).Extensions[imported.ID].Enabled)
}

// TestBootAuditsAnIntegrityFailure covers the load path: tampering discovered at
// boot is written to audit_logs even though no HTTP request caused it.
func TestBootAuditsAnIntegrityFailure(t *testing.T) {
	dataDir := t.TempDir()
	first := newTestManager(t, dataDir, nil)
	imported := importFrontendPackage(t, first)

	manifestPath := filepath.Join(dataDir, "extensions", "com.example.frontend", plugins.ManifestFileName)
	raw, err := os.ReadFile(manifestPath)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(manifestPath, append(raw, []byte("\n\n")...), 0o644))

	recorder := &fakeAudit{}
	restarted := newTestManager(t, dataDir, func(options *Options) {
		options.Audit = recorder
	})
	require.Equal(t, []string{"extension.integrity_failed"}, recorder.actions())
	entry := recorder.last(t)
	require.Equal(t, "failure", entry.Outcome)
	require.Equal(t, "extension", entry.TargetType)
	require.Equal(t, imported.ID, entry.TargetID)

	items, err := restarted.List()
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, string(plugins.IntegrityMismatch), items[0].Integrity)
	require.False(t, items[0].Enabled)
}

// mountAuditedHandler mounts the admin routes with an injected audit recorder
// and a fixed actor, the way the composition root is expected to wire it.
func mountAuditedHandler(t *testing.T, service Service, recorder audit.Recorder) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(ginmiddleware.ErrorHandler(nil))
	handler := NewHandler(service, HandlerConfig{
		Principal: func(c *gin.Context) (string, bool) {
			role, ok := c.Get(testRoleKey)
			if !ok {
				return "", false
			}
			value, ok := role.(string)
			return value, ok
		},
		Audit: recorder,
		Actor: func(*gin.Context) (ActorInfo, bool) {
			return ActorInfo{UserID: "admin-1", SiteID: "site-a", RequestID: "req-9"}, true
		},
	})
	handler.Routes(router, func(c *gin.Context) {
		if role := c.GetHeader("X-Test-Role"); role != "" {
			c.Set(testRoleKey, role)
		}
		c.Next()
	})
	return router
}

// TestHandlerWritesTheExtensionAuditTrail covers install/enable/disable/delete.
func TestHandlerWritesTheExtensionAuditTrail(t *testing.T) {
	recorder := &fakeAudit{}
	enabled := sampleExtension()
	service := &fakeService{
		importResult: enabled,
		setResult:    enabled,
	}
	router := mountAuditedHandler(t, service, recorder)

	body, contentType := multipartPackage(t, "package", "extension.zip", []byte("zip bytes"))
	imported := serve(router, newRequest(t, http.MethodPost, "/extensions/import", "platform_admin", body, contentType))
	require.Equal(t, http.StatusCreated, imported.Code)

	patched := serve(router, newRequest(t, http.MethodPatch, "/extensions/com.example.frontend", "platform_admin",
		bytes.NewBufferString(`{"enabled":false}`), "application/json"))
	require.Equal(t, http.StatusOK, patched.Code)

	reEnabled := serve(router, newRequest(t, http.MethodPatch, "/extensions/com.example.frontend", "platform_admin",
		bytes.NewBufferString(`{"enabled":true}`), "application/json"))
	require.Equal(t, http.StatusOK, reEnabled.Code)

	removed := serve(router, newRequest(t, http.MethodDelete, "/extensions/com.example.frontend", "platform_admin", nil, ""))
	require.Equal(t, http.StatusNoContent, removed.Code)

	require.Equal(t, []string{
		"extension.installed",
		"extension.disabled",
		"extension.enabled",
		"extension.removed",
	}, recorder.actions())
	for _, entry := range recorder.entries {
		require.Equal(t, "admin-1", entry.ActorID)
		require.Equal(t, "req-9", entry.RequestID)
		require.Equal(t, "extension", entry.TargetType)
		require.Equal(t, "success", entry.Outcome)
	}
}

// TestHandlerAuditsARefusedEnable proves the mismatch path is auditable.
func TestHandlerAuditsARefusedEnable(t *testing.T) {
	recorder := &fakeAudit{}
	service := &fakeService{
		setErr: fmt.Errorf("extensions: com.example.frontend: %w", plugins.ErrIntegrityMismatch),
	}
	router := mountAuditedHandler(t, service, recorder)

	response := serve(router, newRequest(t, http.MethodPatch, "/extensions/com.example.frontend", "platform_admin",
		bytes.NewBufferString(`{"enabled":true}`), "application/json"))
	require.Equal(t, http.StatusBadRequest, response.Code)
	require.Contains(t, response.Body.String(), `"reason":"manifest_integrity_mismatch"`)
	require.Equal(t, []string{"extension.integrity_failed"}, recorder.actions())
	require.Equal(t, "failure", recorder.last(t).Outcome)
}
