package media

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
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
	// Deleting is the only destructive media operation, so it sits behind the session
	// guard like the rest of the library. An anonymous reader can never be handed the
	// ability to remove an object it was allowed to view.
	group.DELETE("/:assetID", h.DeleteAsset)
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
	ID string `json:"id"`
	// FileName is the display name the uploader declared. It is omitted rather than
	// sent empty when the row predates the column, because the dashboard falls back to
	// the storage key only on a missing value - an empty string would render as a blank
	// name next to a working image.
	FileName   string `json:"file_name,omitempty"`
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
		FileName:   asset.FileName,
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

// DownloadAsset streams a clean asset, or one of its resized representations.
//
// Only clean assets are reachable: an object that failed inspection must not be
// served even to its uploader, because serving it is exactly the outcome the scan
// exists to prevent.
//
// A reader with no session is served too: an image embedded in a published article has
// to load for a logged-out visitor. The tenant then comes from the resolved host - the
// only thing an anonymous request has - and a members-only site still refuses.
//
// The representation is selected with a query parameter on this same route, so no new
// endpoint (and no contract change) is needed:
//
//	?w=320                     one of the supported widths
//	?variant=thumb             short spelling of ?w=320
//	?variant=medium            ?w=768
//	?variant=original|full     original bytes
func (h *Handler) DownloadAsset(c *gin.Context) {
	width, variantErr := parseVariant(c.Query("w"), c.Query("variant"))
	if variantErr != nil {
		_ = c.Error(apperr.Validation("unknown media variant"))
		return
	}

	asset, reader, servedWidth, err := h.openRepresentation(c, c.Param("assetID"), width)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	defer reader.Close()

	// The type comes from the stored asset (or its derivative), never from the request,
	// and the browser is told not to sniff a different one.
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", "inline")
	c.Header("Cache-Control", cacheControlFor(asset.Purpose))

	// A stable ETag lets the browser revalidate a variant it already holds, which is
	// what keeps a long article of images from re-downloading on every visit.
	etag := representationETag(asset, servedWidth)
	c.Header("ETag", etag)
	if etagMatches(c.GetHeader("If-None-Match"), etag) {
		c.Status(http.StatusNotModified)
		return
	}

	c.DataFromReader(http.StatusOK, asset.Size, asset.MIME, reader, nil)
}

// parseVariant resolves the optional representation selector.
//
// An unknown value is a client error rather than a silent fallback: a typo in a srcset
// would otherwise look like a missing image, and the caller could never discover it.
func parseVariant(widthRaw, variantRaw string) (int, error) {
	widthRaw = strings.TrimSpace(widthRaw)
	variantRaw = strings.ToLower(strings.TrimSpace(variantRaw))

	if widthRaw != "" {
		width, err := strconv.Atoi(widthRaw)
		if err != nil || !ValidVariantWidth(width) {
			return 0, ErrInvalidInput
		}
		return width, nil
	}

	switch variantRaw {
	case "", "original", "full":
		return 0, nil
	case "thumb", "thumbnail":
		return VariantThumbWidth, nil
	case "medium":
		return DefaultVariantWidth, nil
	}

	// Also accept the key-shaped spelling, ?variant=w768.
	if strings.HasPrefix(variantRaw, "w") {
		if width, err := strconv.Atoi(variantRaw[1:]); err == nil && ValidVariantWidth(width) {
			return width, nil
		}
	}
	return 0, ErrInvalidInput
}

// representationETag names one representation of an asset. The asset id and the width
// are immutable, so the value is stable across requests and replicas.
func representationETag(asset Asset, width int) string {
	if width > 0 {
		return `"` + asset.ID + "-w" + strconv.Itoa(width) + `"`
	}
	return `"` + asset.ID + `"`
}

// etagMatches implements the If-None-Match comparison, including the weak prefix and
// the wildcard. A list is compared member by member.
func etagMatches(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" {
			return true
		}
		if strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}

// openRepresentation returns the requested derivative, or the original when a
// derivative cannot be produced.
//
// servedWidth is zero when the original bytes are returned: the ETag must describe what
// was actually sent, not what was asked for.
func (h *Handler) openRepresentation(
	c *gin.Context,
	assetID string,
	width int,
) (Asset, io.ReadCloser, int, error) {
	if width <= 0 {
		asset, reader, err := h.openForCaller(c, assetID)
		return asset, reader, 0, err
	}

	asset, reader, err := h.openVariantForCaller(c, assetID, width)
	if err == nil {
		return asset, reader, width, nil
	}
	if !errors.Is(err, ErrDerivativeUnavailable) {
		// A non-clean, out-of-scope or missing asset must stay 404. Only a clean asset
		// whose bytes cannot be resized falls through to the larger original.
		return Asset{}, nil, width, err
	}
	asset, reader, err = h.openForCaller(c, assetID)
	return asset, reader, 0, err
}

// openVariantForCaller applies the same caller/site rules as openForCaller before the
// service produces a derivative.
func (h *Handler) openVariantForCaller(
	c *gin.Context,
	assetID string,
	width int,
) (Asset, io.ReadCloser, error) {
	if actor, ok := h.principal(c); ok {
		return h.service.OpenVariant(c.Request.Context(), actor, assetID, width)
	}

	resolved, ok := h.site(c)
	if !ok {
		return Asset{}, nil, apperr.New(apperr.CodeSiteNotFound)
	}
	if resolved.IsMembersOnly() {
		return Asset{}, nil, apperr.Unauthenticated().WithDetail("reason", "members_only_site")
	}
	return h.service.OpenVariantInSite(c.Request.Context(), resolved.ID, assetID, width)
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

// DeleteAsset removes an asset and its stored object.
//
// The refusal a caller can act on is reported as such: content that still references the
// asset answers 409, because removing the image from that article is exactly the next
// step. Everything else - someone else's object, an asset of another site, an id that
// never existed - answers 404. Distinguishing them would confirm that another account's
// upload exists, which is the disclosure the read path already refuses to make.
func (h *Handler) DeleteAsset(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	if err := h.service.DeleteAsset(c.Request.Context(), actor, c.Param("assetID")); err != nil {
		_ = c.Error(failDelete(err))
		return
	}

	// No body: the caller asked for the resource to stop existing, so there is nothing
	// left to describe.
	c.Status(http.StatusNoContent)
}

// failDelete translates a delete failure into the API error model.
func failDelete(err error) *apperr.Problem {
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrPermissionDenied) {
		return apperr.NotFound("media asset")
	}
	return mapError(err)
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
	case errors.Is(err, ErrAssetInUse):
		// A conflict, not a validation failure: the request is well formed, the state of
		// the site is what refuses it.
		return apperr.Conflict(apperr.CodeConflict).
			WithMessage("素材正被内容引用，无法删除").
			WithDetail("reason", "asset_in_use")
	case errors.Is(err, ErrQuotaExceeded):
		return apperr.New(apperr.CodeQuotaExceeded)
	case errors.Is(err, ErrSecurityUnavailable):
		return apperr.New(apperr.CodeSecurityUnavailable)
	case errors.Is(err, ErrScanRejected):
		return apperr.Validation("file rejected by security scan")
	case errors.Is(err, ErrStorageMissing):
		return apperr.Internal(err).WithDetail("reason", "storage_not_configured")
	case errors.Is(err, ErrStorageQuotaExceeded):
		return apperr.New(apperr.CodeStorageQuotaExceeded).
			WithMessage("当前用途的储存空间已满，上传已停止").
			WithDetail("reason", "storage_quota_exceeded")
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
