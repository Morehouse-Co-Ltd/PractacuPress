package media

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// SiteFunc returns the site the request host resolved to.
type SiteFunc func(*gin.Context) (site.Site, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
	// Site exposes the resolved site so a published article's images can be served to a
	// reader without a session. Downloads are the only anonymous media operation.
	Site SiteFunc
}

// Handler exposes the two phase upload flow over HTTP.
type Handler struct {
	service   *Service
	principal PrincipalFunc
	site      SiteFunc
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (Actor, bool) { return Actor{}, false }
	}
	siteOf := cfg.Site
	if siteOf == nil {
		siteOf = func(*gin.Context) (site.Site, bool) { return site.Site{}, false }
	}
	return &Handler{service: service, principal: principal, site: siteOf}
}

// Routes mounts the media endpoints under /api/v1.
func (h *Handler) Routes(r gin.IRouter, requireAuth, optionalAuth gin.HandlerFunc) {
	// Images embedded in a published article must load for a reader without a session.
	r.GET("/media/:assetID", optionalAuth, h.DownloadAsset)

	group := r.Group("/media", requireAuth)
	// The library listing is a session only view: an anonymous reader has no site to
	// enumerate, and an asset that failed inspection must stay invisible to the public.
	group.GET("", h.ListAssets)
	group.POST("/uploads", h.CreateUpload)
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
	// Purpose is absent on rows that predate per purpose storage, so it stays optional
	// on the wire too instead of being reported as an empty string.
	Purpose   string `json:"purpose,omitempty"`
	CreatedAt string `json:"created_at"`
	// URL is the download route of this asset, derived rather than stored: a client that
	// keeps the value must end up on the path the server actually serves.
	URL string `json:"url"`
}

// assetView renders an asset for the wire.
func assetView(asset Asset) assetResponse {
	return assetResponse{
		ID:         asset.ID,
		StorageKey: asset.StorageKey,
		MIME:       asset.MIME,
		Size:       asset.Size,
		ScanStatus: string(asset.ScanStatus),
		ReasonCode: asset.ReasonCode,
		Purpose:    string(asset.Purpose),
		CreatedAt:  asset.CreatedAt.UTC().Format(time.RFC3339Nano),
		URL:        "/api/v1/media/" + asset.ID,
	}
}

// parseLimit reads the page size of a listing.
//
// An absent value is passed on as zero, which the service turns into the default. Any
// other value must be an integer inside the documented bounds: clamping silently would
// tell the client its page size was honoured when it was not.
func parseLimit(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > MaxListLimit {
		return 0, ErrInvalidInput
	}
	return limit, nil
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
//
// A reader with no session is served too: an image embedded in a published article has
// to load for a logged-out visitor. The tenant then comes from the resolved host - the
// only thing an anonymous request has - and a members-only site still refuses.
func (h *Handler) DownloadAsset(c *gin.Context) {
	asset, reader, err := h.openForCaller(c, c.Param("assetID"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	defer reader.Close()

	// The type comes from the stored asset, never from the request, and the browser is
	// told not to sniff a different one.
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", "inline")
	c.Header("Cache-Control", cacheControlFor(asset.Purpose))

	c.DataFromReader(http.StatusOK, asset.Size, asset.MIME, reader, nil)
}

// openForCaller resolves the asset for an authenticated caller or an anonymous reader.
//
// The order matters: a caller with a session is scoped by its token's site, so a member
// of site A cannot read site B's media by aiming at site B's hostname. An anonymous
// reader has no token, so the resolved site is the only scope available.
func (h *Handler) openForCaller(c *gin.Context, assetID string) (Asset, io.ReadCloser, error) {
	if actor, ok := h.principal(c); ok {
		return h.service.OpenAsset(c.Request.Context(), actor, assetID)
	}

	resolved, ok := h.site(c)
	if !ok {
		return Asset{}, nil, apperr.New(apperr.CodeSiteNotFound)
	}
	if resolved.IsMembersOnly() {
		return Asset{}, nil, apperr.Unauthenticated().WithDetail("reason", "members_only_site")
	}
	return h.service.OpenAssetInSite(c.Request.Context(), resolved.ID, assetID)
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
		// A body that hit the transport's ceiling is truncated mid-read, which would
		// otherwise be reported as a missing field and send the caller hunting for the
		// wrong problem.
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			_ = c.Error(apperr.Validation("uploaded file exceeds the accepted size"))
			return
		}
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

	c.JSON(status, assetView(asset))
}

// ListAssets returns one page of the site's media library.
//
// The library shows every scan verdict, including rejected files, because an editor
// has to see what happened to an upload; only clean assets are downloadable or
// referenceable, and that is enforced on the read path rather than by hiding rows.
func (h *Handler) ListAssets(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	limit, err := parseLimit(c.Query("limit"))
	if err != nil {
		_ = c.Error(apperr.Validation("limit must be an integer between 1 and 100"))
		return
	}

	cursor, err := page.Decode(c.Query("cursor"))
	if err != nil {
		_ = c.Error(apperr.New(apperr.CodeInvalidCursor).WithRequestID(c.GetHeader("X-Request-ID")))
		return
	}

	assets, next, err := h.service.ListAssets(
		c.Request.Context(),
		actor,
		AssetFilter{
			Purpose:    Purpose(strings.TrimSpace(c.Query("purpose"))),
			ScanStatus: ScanStatus(strings.TrimSpace(c.Query("scan_status"))),
		},
		limit,
		cursor,
	)
	if err != nil {
		failList(c, err)
		return
	}

	items := make([]assetResponse, 0, len(assets))
	for _, asset := range assets {
		items = append(items, assetView(asset))
	}

	c.JSON(http.StatusOK, gin.H{
		"items":       items,
		"next_cursor": next,
		"has_more":    next != "",
	})
}

// failList translates a listing failure into the API error model.
//
// mapError speaks about uploads, which is the wrong answer for a refused filter value,
// and a broken cursor has its own code so a client can tell an unusable token from an
// unknown parameter.
func failList(c *gin.Context, err error) {
	switch {
	case errors.Is(err, page.ErrInvalidCursor):
		_ = c.Error(apperr.New(apperr.CodeInvalidCursor).WithRequestID(c.GetHeader("X-Request-ID")))
	case errors.Is(err, ErrInvalidInput):
		_ = c.Error(apperr.Validation("unknown media filter"))
	default:
		_ = c.Error(mapError(err))
	}
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

// cacheControlFor keeps public site assets cacheable at the edge while leaving content
// and attachments private: a published article can be withdrawn, its images must not
// stay in a shared cache forever.
func cacheControlFor(purpose Purpose) string {
	switch purpose {
	case PurposeSite, PurposeAvatar:
		return "public, max-age=31536000, immutable"
	default:
		return "private, max-age=300"
	}
}
