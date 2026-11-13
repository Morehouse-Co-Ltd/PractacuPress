package extensions

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	ginmiddleware "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// testRoleKey is the gin context key the fake guard writes; the handler's
// Principal func reads it. Production wires middleware.PrincipalFrom instead.
const testRoleKey = "extensions.test.role"

// fakeService records what the handler asked for and returns scripted values.
type fakeService struct {
	items []Extension
	calls []string

	listErr      error
	importResult Extension
	importErr    error
	importBytes  int64
	importData   []byte

	setResult  Extension
	setErr     error
	setID      string
	setEnabled bool

	removeErr error
	removeID  string
}

func (f *fakeService) List() ([]Extension, error) {
	f.calls = append(f.calls, "list")
	return f.items, f.listErr
}

func (f *fakeService) ImportZip(reader io.Reader, maxBytes int64) (Extension, error) {
	f.calls = append(f.calls, "import")
	data, err := io.ReadAll(reader)
	if err != nil {
		return Extension{}, err
	}
	f.importData = data
	f.importBytes = maxBytes
	return f.importResult, f.importErr
}

func (f *fakeService) SetEnabled(id string, enabled bool) (Extension, error) {
	f.calls = append(f.calls, "set_enabled")
	f.setID, f.setEnabled = id, enabled
	return f.setResult, f.setErr
}

func (f *fakeService) Remove(id string) error {
	f.calls = append(f.calls, "remove")
	f.removeID = id
	return f.removeErr
}

// newTestRouter mounts the handler with a guard that only forwards the caller's
// role from a header, so each test can act as an anonymous, site or platform
// administrator without a token issuer.
func newTestRouter(t *testing.T, service Service) *gin.Engine {
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
	})
	handler.Routes(router, func(c *gin.Context) {
		if role := c.GetHeader("X-Test-Role"); role != "" {
			c.Set(testRoleKey, role)
		}
		c.Next()
	})
	return router
}

func serve(router *gin.Engine, request *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func newRequest(t *testing.T, method, path, role string, body *bytes.Buffer, contentType string) *http.Request {
	t.Helper()
	var reader *bytes.Buffer
	if body != nil {
		reader = body
	} else {
		reader = &bytes.Buffer{}
	}
	request := httptest.NewRequest(method, path, reader)
	if role != "" {
		request.Header.Set("X-Test-Role", role)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	return request
}

// multipartPackage builds one multipart body carrying a zip under field.
func multipartPackage(t *testing.T, field, filename string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile(field, filename)
	require.NoError(t, err)
	_, err = part.Write(data)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	return body, writer.FormDataContentType()
}

func sampleExtension() Extension {
	return Extension{
		ID:          "com.example.frontend",
		Name:        "Frontend",
		Version:     "1.0.0",
		Description: "A browser-only extension.",
		State:       "enabled",
		Enabled:     true,
		Runtime:     "none",
		Permissions: []string{"ui.inject"},
		Frontend: &ExtensionFrontend{
			Entry:  "/plugins/com.example.frontend/1.0.0/client.js",
			Styles: []string{},
			Slots:  []string{},
			Blocks: []ExtensionBlock{},
		},
	}
}

// TestHandlerListRequiresPlatformAdmin covers 401, 403 and 200.
func TestHandlerListRequiresPlatformAdmin(t *testing.T) {
	service := &fakeService{items: []Extension{sampleExtension()}}
	router := newTestRouter(t, service)

	anonymous := serve(router, newRequest(t, http.MethodGet, "/extensions", "", nil, ""))
	require.Equal(t, http.StatusUnauthorized, anonymous.Code)
	require.Equal(t, "application/problem+json", anonymous.Header().Get("Content-Type"))
	require.Contains(t, anonymous.Body.String(), `"code":"unauthenticated"`)

	siteAdmin := serve(router, newRequest(t, http.MethodGet, "/extensions", "site_admin", nil, ""))
	require.Equal(t, http.StatusForbidden, siteAdmin.Code)
	require.Contains(t, siteAdmin.Body.String(), `"code":"permission_denied"`)
	require.Contains(t, siteAdmin.Body.String(), `"reason":"platform_admin_required"`)

	platformAdmin := serve(router, newRequest(t, http.MethodGet, "/extensions", "platform_admin", nil, ""))
	require.Equal(t, http.StatusOK, platformAdmin.Code)
	require.Equal(t, "no-store", platformAdmin.Header().Get("Cache-Control"))
	var body struct {
		Items []Extension `json:"items"`
	}
	require.NoError(t, json.Unmarshal(platformAdmin.Body.Bytes(), &body))
	require.Len(t, body.Items, 1)
	require.Equal(t, "com.example.frontend", body.Items[0].ID)
}

// TestHandlerListReturnsAnEmptyArrayInsteadOfNull keeps the JSON shape stable.
func TestHandlerListReturnsAnEmptyArrayInsteadOfNull(t *testing.T) {
	router := newTestRouter(t, &fakeService{})
	recorder := serve(router, newRequest(t, http.MethodGet, "/extensions", "platform_admin", nil, ""))
	require.Equal(t, http.StatusOK, recorder.Code)
	require.JSONEq(t, `{"items":[]}`, recorder.Body.String())
}

// TestHandlerImportAcceptsBothFieldNames covers the documented and legacy field.
func TestHandlerImportAcceptsBothFieldNames(t *testing.T) {
	for _, field := range []string{"package", "file"} {
		t.Run(field, func(t *testing.T) {
			service := &fakeService{importResult: sampleExtension()}
			router := newTestRouter(t, service)
			body, contentType := multipartPackage(t, field, "extension.zip", []byte("zip bytes"))
			recorder := serve(router, newRequest(t, http.MethodPost, "/extensions/import", "platform_admin", body, contentType))
			require.Equal(t, http.StatusCreated, recorder.Code)
			require.Contains(t, service.calls, "import")
			require.Equal(t, int64(MaxPackageBytes), service.importBytes)
			require.Equal(t, []byte("zip bytes"), service.importData)
			var response struct {
				Extension Extension `json:"extension"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
			require.Equal(t, "com.example.frontend", response.Extension.ID)
			require.True(t, response.Extension.Enabled)
		})
	}
}

// TestHandlerImportRejectsMissingAndBrokenPackages covers the 400 mapping.
func TestHandlerImportRejectsMissingAndBrokenPackages(t *testing.T) {
	t.Run("empty request", func(t *testing.T) {
		router := newTestRouter(t, &fakeService{})
		recorder := serve(router, newRequest(t, http.MethodPost, "/extensions/import", "platform_admin", nil, "multipart/form-data; boundary=none"))
		require.Equal(t, http.StatusBadRequest, recorder.Code)
		require.Contains(t, recorder.Body.String(), `"code":"validation_failed"`)
	})

	t.Run("invalid package", func(t *testing.T) {
		service := &fakeService{importErr: ErrInvalidPackage}
		router := newTestRouter(t, service)
		body, contentType := multipartPackage(t, "package", "bad.zip", []byte("nope"))
		recorder := serve(router, newRequest(t, http.MethodPost, "/extensions/import", "platform_admin", body, contentType))
		require.Equal(t, http.StatusBadRequest, recorder.Code)
		require.Contains(t, recorder.Body.String(), `"reason":"invalid_extension_package"`)
	})

	t.Run("oversized package", func(t *testing.T) {
		service := &fakeService{importErr: ErrPackageTooLarge}
		router := newTestRouter(t, service)
		body, contentType := multipartPackage(t, "package", "big.zip", []byte("nope"))
		recorder := serve(router, newRequest(t, http.MethodPost, "/extensions/import", "platform_admin", body, contentType))
		require.Equal(t, http.StatusBadRequest, recorder.Code)
		require.Contains(t, recorder.Body.String(), `"reason":"package_too_large"`)
	})

	t.Run("site administrator", func(t *testing.T) {
		service := &fakeService{}
		router := newTestRouter(t, service)
		body, contentType := multipartPackage(t, "package", "extension.zip", []byte("zip"))
		recorder := serve(router, newRequest(t, http.MethodPost, "/extensions/import", "site_admin", body, contentType))
		require.Equal(t, http.StatusForbidden, recorder.Code)
		require.Empty(t, service.calls)
	})
}

// TestHandlerSetEnabled covers PATCH success and validation.
func TestHandlerSetEnabled(t *testing.T) {
	disabled := sampleExtension()
	disabled.Enabled = false
	disabled.State = "disabled"

	service := &fakeService{setResult: disabled}
	router := newTestRouter(t, service)
	recorder := serve(router, newRequest(t, http.MethodPatch, "/extensions/com.example.frontend", "platform_admin",
		bytes.NewBufferString(`{"enabled":false}`), "application/json"))
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "com.example.frontend", service.setID)
	require.False(t, service.setEnabled)
	var response struct {
		Extension Extension `json:"extension"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.False(t, response.Extension.Enabled)

	malformed := serve(router, newRequest(t, http.MethodPatch, "/extensions/com.example.frontend", "platform_admin",
		bytes.NewBufferString(`{`), "application/json"))
	require.Equal(t, http.StatusBadRequest, malformed.Code)
	require.Contains(t, malformed.Body.String(), `"code":"validation_failed"`)

	missing := serve(router, newRequest(t, http.MethodPatch, "/extensions/com.example.frontend", "platform_admin",
		bytes.NewBufferString(`{}`), "application/json"))
	require.Equal(t, http.StatusBadRequest, missing.Code)

	notFoundService := &fakeService{setErr: ErrExtensionNotFound}
	notFound := serve(newTestRouter(t, notFoundService), newRequest(t, http.MethodPatch, "/extensions/missing", "platform_admin",
		bytes.NewBufferString(`{"enabled":true}`), "application/json"))
	require.Equal(t, http.StatusNotFound, notFound.Code)
	require.Contains(t, notFound.Body.String(), `"code":"not_found"`)
}

// TestHandlerRemove covers DELETE 204 and 404.
func TestHandlerRemove(t *testing.T) {
	service := &fakeService{}
	router := newTestRouter(t, service)
	recorder := serve(router, newRequest(t, http.MethodDelete, "/extensions/com.example.frontend", "platform_admin", nil, ""))
	require.Equal(t, http.StatusNoContent, recorder.Code)
	require.Empty(t, recorder.Body.String())
	require.Equal(t, "com.example.frontend", service.removeID)

	notFound := serve(newTestRouter(t, &fakeService{removeErr: ErrExtensionNotFound}),
		newRequest(t, http.MethodDelete, "/extensions/missing", "platform_admin", nil, ""))
	require.Equal(t, http.StatusNotFound, notFound.Code)
	require.Contains(t, notFound.Body.String(), `"code":"not_found"`)

	member := serve(newTestRouter(t, &fakeService{}),
		newRequest(t, http.MethodDelete, "/extensions/com.example.frontend", "member", nil, ""))
	require.Equal(t, http.StatusForbidden, member.Code)
}

// TestHandlerErrorsNeverLeakTheCause proves the problem body carries a stable code
// and not the filesystem detail of the manager error.
func TestHandlerErrorsNeverLeakTheCause(t *testing.T) {
	service := &fakeService{importErr: errors.Join(ErrInvalidPackage, errors.New("C:/secret/path"))}
	router := newTestRouter(t, service)
	body, contentType := multipartPackage(t, "package", "bad.zip", []byte("nope"))
	recorder := serve(router, newRequest(t, http.MethodPost, "/extensions/import", "platform_admin", body, contentType))
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	require.NotContains(t, recorder.Body.String(), "secret")
	require.Contains(t, recorder.Body.String(), `"reason":"invalid_extension_package"`)
}
