package media

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

func newEngine(repo Repository, scanner Scanner, actor Actor) *gin.Engine {
	gin.SetMode(gin.TestMode)

	service, err := NewService(ServiceConfig{
		Repository: repo,
		Scanner:    scanner,
		Now:        func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		panic(err)
	}

	handler := NewHandler(service, HandlerConfig{
		Principal: func(*gin.Context) (Actor, bool) { return actor, true },
	})

	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	handler.Routes(r, func(c *gin.Context) { c.Next() }, func(c *gin.Context) { c.Next() })
	return r
}

func do(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func decodeBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	return payload
}

func ownerActor() Actor { return Actor{UserID: "u1", SiteID: "s1"} }

func TestCreateUploadReturnsSession(t *testing.T) {
	r := newEngine(newFakeRepo(), &fakeScanner{result: ScanResult{Status: ScanClean}}, ownerActor())

	w := do(r, http.MethodPost, "/media/uploads",
		`{"file_name":"photo.png","mime_type":"image/png","size":1024,"purpose":"content"}`)

	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	payload := decodeBody(t, w)
	require.Equal(t, "pending", payload["status"])
	require.NotEmpty(t, payload["storage_key"])
	require.NotContains(t, payload["storage_key"], "photo")
}

func TestCreateUploadQuotaExceededReturns429Problem(t *testing.T) {
	repo := newFakeRepo()
	repo.insertErr = ErrQuotaExceeded
	r := newEngine(repo, &fakeScanner{result: ScanResult{Status: ScanClean}}, ownerActor())

	w := do(r, http.MethodPost, "/media/uploads",
		`{"file_name":"photo.png","mime_type":"image/png","size":1024,"purpose":"content"}`)

	require.Equal(t, http.StatusTooManyRequests, w.Code, w.Body.String())
	require.Equal(t, "quota_exceeded", decodeBody(t, w)["code"])
}

func TestCreateUploadAcceptsSitePurpose(t *testing.T) {
	repo := newFakeRepo()
	r := newEngine(repo, &fakeScanner{result: ScanResult{Status: ScanClean}}, ownerActor())

	created := do(r, http.MethodPost, "/media/uploads",
		`{"file_name":"hero.png","mime_type":"image/png","size":1024,"purpose":"site"}`)
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())

	id, _ := decodeBody(t, created)["id"].(string)
	require.NotEmpty(t, id)
	require.Equal(t, PurposeSite, repo.uploads[id].Purpose)

	completed := do(r, http.MethodPost, "/media/uploads/"+id+"/complete", "")
	require.Equal(t, http.StatusOK, completed.Code, completed.Body.String())
	require.Equal(t, "clean", decodeBody(t, completed)["scan_status"])
	require.Equal(t, PurposeSite, repo.assets[0].Purpose, "the asset must keep the site purpose")
}

func TestCreateUploadRejectsAttachmentTypeForSitePurpose(t *testing.T) {
	r := newEngine(newFakeRepo(), &fakeScanner{}, ownerActor())

	w := do(r, http.MethodPost, "/media/uploads",
		`{"file_name":"doc.pdf","mime_type":"application/pdf","size":1024,"purpose":"site"}`)

	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, "validation_failed", decodeBody(t, w)["code"])
}

func TestCreateUploadRejectsDisallowedType(t *testing.T) {
	r := newEngine(newFakeRepo(), &fakeScanner{}, ownerActor())

	w := do(r, http.MethodPost, "/media/uploads",
		`{"file_name":"payload.exe","mime_type":"application/x-msdownload","size":10,"purpose":"attachment"}`)

	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, "validation_failed", decodeBody(t, w)["code"])
}

func TestCompleteUploadReturnsCleanAsset(t *testing.T) {
	repo := newFakeRepo()
	r := newEngine(repo, &fakeScanner{result: ScanResult{Status: ScanClean}}, ownerActor())

	created := do(r, http.MethodPost, "/media/uploads",
		`{"file_name":"photo.png","mime_type":"image/png","size":1024,"purpose":"content"}`)
	require.Equal(t, http.StatusCreated, created.Code)
	id, _ := decodeBody(t, created)["id"].(string)

	w := do(r, http.MethodPost, "/media/uploads/"+id+"/complete", "")

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	payload := decodeBody(t, w)
	require.Equal(t, "clean", payload["scan_status"])
	require.Equal(t, "photo.png", payload["file_name"],
		"the detail response carries the declared display name")
}

func TestCompleteUploadFailsClosedWhenScannerDown(t *testing.T) {
	repo := newFakeRepo()
	r := newEngine(repo, &fakeScanner{err: errUnavailable}, ownerActor())

	created := do(r, http.MethodPost, "/media/uploads",
		`{"file_name":"photo.png","mime_type":"image/png","size":1024,"purpose":"content"}`)
	id, _ := decodeBody(t, created)["id"].(string)

	w := do(r, http.MethodPost, "/media/uploads/"+id+"/complete", "")

	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.Equal(t, "security_unavailable", decodeBody(t, w)["code"])
}

func TestCompleteUploadRejectedIsUnprocessable(t *testing.T) {
	repo := newFakeRepo()
	r := newEngine(repo, &fakeScanner{result: ScanResult{Status: ScanRejected, ReasonCode: "eicar"}}, ownerActor())

	created := do(r, http.MethodPost, "/media/uploads",
		`{"file_name":"photo.png","mime_type":"image/png","size":1024,"purpose":"content"}`)
	id, _ := decodeBody(t, created)["id"].(string)

	w := do(r, http.MethodPost, "/media/uploads/"+id+"/complete", "")

	require.Equal(t, http.StatusUnprocessableEntity, w.Code)
	payload := decodeBody(t, w)
	require.Equal(t, "rejected", payload["scan_status"])
	require.Equal(t, "eicar", payload["scan_reason"])
}

var errUnavailable = &unavailableError{}

type unavailableError struct{}

func (*unavailableError) Error() string { return "grpc down" }
