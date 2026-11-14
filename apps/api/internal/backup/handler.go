package backup

import (
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
}

// Handler exposes backups and site transfer over HTTP.
//
// Backup packages contain the whole deployment database, so they are platform
// administrator only. Site export and import are site administrator operations:
// they never read another site's rows.
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

// Routes mounts backups and site transfer under /api/v1.
//
// protected carries the extra middleware the transport wants on the site scoped
// routes, notably the step-up guard that re-authenticates an import.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc, protected ...gin.HandlerFunc) {
	platform := r.Group("/platform/backups", requireAuth)
	platform.POST("", h.create)
	platform.GET("", h.list)
	platform.GET("/:backupID/download", h.download)

	guards := append([]gin.HandlerFunc{requireAuth}, protected...)
	sites := r.Group("/sites/:siteID", guards...)
	sites.GET("/export", h.export)
	sites.POST("/import", h.importArchive)
}

// actor resolves the caller or writes 401.
func (h *Handler) actor(c *gin.Context) (Actor, bool) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return Actor{}, false
	}
	return actor, true
}

// create builds a whole instance backup and returns its metadata.
func (h *Handler) create(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}
	if err := requirePlatformAdmin(actor); err != nil {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "platform_admin_required"))
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(errors.New("backup service is not configured")))
		return
	}
	artifact, err := h.service.CreateBackup(c.Request.Context())
	if err != nil {
		_ = c.Error(h.mapError(err))
		return
	}
	c.JSON(http.StatusCreated, artifact)
}

// list returns stored packages newest first.
func (h *Handler) list(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(errors.New("backup service is not configured")))
		return
	}
	artifacts, err := h.service.ListBackups(c.Request.Context(), actor)
	if err != nil {
		_ = c.Error(h.mapError(err))
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": artifacts})
}

// download streams one stored package.
func (h *Handler) download(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(errors.New("backup service is not configured")))
		return
	}
	artifact, file, err := h.service.OpenBackup(c.Request.Context(), actor, c.Param("backupID"))
	if err != nil {
		_ = c.Error(h.mapError(err))
		return
	}
	_ = file.Close()
	c.FileAttachment(artifact.Path, artifact.FileName)
}

// export writes a site package directly to the response.
func (h *Handler) export(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(errors.New("backup service is not configured")))
		return
	}
	publishedOnly := false
	if raw := c.Query("published_only"); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			_ = c.Error(apperr.Validation("published_only must be true or false").
				WithDetail("field", "published_only"))
			return
		}
		publishedOnly = parsed
	}
	result, err := h.service.ExportSite(c.Request.Context(), actor, c.Param("siteID"), publishedOnly)
	if err != nil {
		_ = c.Error(h.mapError(err))
		return
	}
	defer os.Remove(result.Path)
	file, err := os.Open(result.Path)
	if err != nil {
		_ = c.Error(apperr.Internal(err))
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		_ = c.Error(apperr.Internal(err))
		return
	}
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(result.FileName, `"`, "")+`"`)
	c.Header("Content-Length", strconv.FormatInt(info.Size(), 10))
	c.Header("X-Content-Count", strconv.Itoa(result.ContentCount))
	c.Header("X-Media-Count", strconv.Itoa(result.MediaCount))
	http.ServeContent(c.Writer, c.Request, result.FileName, info.ModTime(), file)
}

// importArchive accepts one multipart package and returns the per item report.
func (h *Handler) importArchive(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(errors.New("backup service is not configured")))
		return
	}
	header, err := c.FormFile("file")
	if err != nil {
		_ = c.Error(apperr.Validation("a zip package is required").
			WithDetail("field", "file"))
		return
	}
	if header.Size <= 0 || header.Size > MaxImportBytes {
		_ = c.Error(apperr.Validation("the import package is empty or too large").
			WithDetail("field", "file"))
		return
	}
	opened, err := header.Open()
	if err != nil {
		_ = c.Error(apperr.Internal(err))
		return
	}
	defer opened.Close()
	readerAt, ok := opened.(io.ReaderAt)
	if !ok {
		_ = c.Error(apperr.Internal(errors.New("multipart file is not seekable")))
		return
	}
	report, err := h.service.ImportSite(
		c.Request.Context(), actor, c.Param("siteID"), readerAt, header.Size,
		ImportOptions{Conflict: c.DefaultPostForm("conflict", ConflictRename), RequestID: middleware.RequestIDFrom(c)},
	)
	if err != nil {
		_ = c.Error(h.mapError(err))
		return
	}
	c.JSON(http.StatusOK, report)
}

// mapError translates the package sentinels into problem documents.
func (h *Handler) mapError(err error) *apperr.Problem {
	switch {
	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied().WithDetail("reason", "backup_permission_denied")
	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("backup")
	case errors.Is(err, ErrUnsupportedDriver):
		return apperr.Validation(cleanError(err)).WithDetail("reason", "database_driver_unsupported")
	case errors.Is(err, ErrConfirmationRequired):
		return apperr.Validation(cleanError(err)).WithDetail("reason", "confirmation_required")
	case errors.Is(err, ErrChecksumMismatch), errors.Is(err, ErrInvalidArchive):
		return apperr.Validation(cleanError(err)).WithDetail("reason", "invalid_backup_package")
	case errors.Is(err, ErrEncryptionKeyRequired), errors.Is(err, ErrEncryptionKeyInvalid),
		errors.Is(err, ErrDecryptionFailed):
		return apperr.Validation(cleanError(err)).WithDetail("reason", "backup_encryption_error")
	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation(cleanError(err))
	default:
		var problem *apperr.Problem
		if errors.As(err, &problem) {
			return problem
		}
		return apperr.Internal(err)
	}
}
