package media

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
}

// Handler exposes the two phase upload flow over HTTP.
type Handler struct {
	service   *Service
	principal PrincipalFunc
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (Actor, bool) { return Actor{}, false }
	}
	return &Handler{service: service, principal: principal}
}

// Routes mounts the media endpoints under /api/v1.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/media", requireAuth)
	group.POST("/uploads", h.CreateUpload)
	group.GET("/:assetID", h.DownloadAsset)
	group.POST("/uploads/:uploadID/content", h.UploadContent)
	group.POST("/uploads/:uploadID/complete", h.CompleteUpload)
}

type uploadRequest struct {
	FileName string `json:"file_name"`
	MIME     string `json:"mime_type"`
	Size     int64  `json:"size"`
	Purpose  string `json:"purpose"`
}

type uploadResponse struct {
	ID         string `json:"id"`
	FileName   string `json:"file_name"`
	StorageKey string `json:"storage_key"`
	Status     string `json:"status"`
	ExpiresAt  string `json:"expires_at"`
}

type assetResponse struct {
	ID         string `json:"id"`
	StorageKey string `json:"storage_key"`
	MIME       string `json:"mime_type"`
	Size       int64  `json:"size"`
	ScanStatus string `json:"scan_status"`
	ReasonCode string `json:"scan_reason,omitempty"`
}

// CreateUpload opens an upload session.
func (h *Handler) CreateUpload(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	var req uploadRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	upload, err := h.service.CreateUpload(c.Request.Context(), actor, UploadRequest{
		FileName:     req.FileName,
		DeclaredMIME: req.MIME,
		Size:         req.Size,
		Purpose:      Purpose(req.Purpose),
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusCreated, uploadResponse{
		ID:         upload.ID,
		FileName:   upload.FileName,
		StorageKey: upload.StorageKey,
		Status:     string(upload.Status),
		ExpiresAt:  upload.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	})
}

// DownloadAsset streams a clean asset.
//
// Only clean assets are reachable: an object that failed inspection must not be
// served even to its uploader, because serving it is exactly the outcome the scan
// exists to prevent.
func (h *Handler) DownloadAsset(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	asset, reader, err := h.service.OpenAsset(c.Request.Context(), actor, c.Param("assetID"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	defer reader.Close()

	// The type comes from the stored asset, never from the request, and the browser is
	// told not to sniff a different one.
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", "inline")
	c.Header("Cache-Control", "private, max-age=300")

	c.DataFromReader(http.StatusOK, asset.Size, asset.MIME, reader, nil)
}
// UploadContent accepts the bytes for an open session.
func (h *Handler) UploadContent(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		_ = c.Error(apperr.Validation("multipart field 'file' is required"))
		return
	}
	defer file.Close()

	upload, err := h.service.StoreContent(c.Request.Context(), actor, c.Param("uploadID"), file, header.Size)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusOK, uploadResponse{
		ID:         upload.ID,
		FileName:   upload.FileName,
		StorageKey: upload.StorageKey,
		Status:     string(upload.Status),
		ExpiresAt:  upload.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	})
}
// CompleteUpload inspects the stored object and returns the resulting asset.
func (h *Handler) CompleteUpload(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	asset, err := h.service.CompleteUpload(c.Request.Context(), actor, c.Param("uploadID"))
	if err != nil && !errors.Is(err, ErrScanRejected) {
		_ = c.Error(mapError(err))
		return
	}

	status := http.StatusOK
	if errors.Is(err, ErrScanRejected) {
		// The asset exists for the audit trail, but it is not usable.
		status = http.StatusUnprocessableEntity
	}

	c.JSON(status, assetResponse{
		ID:         asset.ID,
		StorageKey: asset.StorageKey,
		MIME:       asset.MIME,
		Size:       asset.Size,
		ScanStatus: string(asset.ScanStatus),
		ReasonCode: asset.ReasonCode,
	})
}

// mapError translates media failures into the API error model.
func mapError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation("invalid upload")
	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("upload")
	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()
	case errors.Is(err, ErrAlreadyCompleted):
		return apperr.Conflict(apperr.CodeConflict).WithMessage("上传已完成")
	case errors.Is(err, ErrSecurityUnavailable):
		return apperr.New(apperr.CodeSecurityUnavailable)
	case errors.Is(err, ErrScanRejected):
		return apperr.Validation("file rejected by security scan")
	case errors.Is(err, ErrStorageMissing):
		return apperr.Internal(err).WithDetail("reason", "storage_not_configured")
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}
