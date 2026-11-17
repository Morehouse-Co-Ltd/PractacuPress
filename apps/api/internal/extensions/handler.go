package extensions

import (
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/plugins"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// MaxPackageBytes is the ceiling of one uploaded extension package. The manager
// enforces the same bound; the handler checks it first so an oversized upload is
// refused before it is buffered.
const MaxPackageBytes int64 = 32 << 20

// Service is the application surface the HTTP handler needs. It is an interface
// so the contract tests can mount the routes with an inert implementation.
type Service interface {
	List() ([]Extension, error)
	ImportZip(reader io.Reader, maxBytes int64) (Extension, error)
	SetEnabled(id string, enabled bool) (Extension, error)
	Remove(id string) error
}

// PrincipalFunc returns the authenticated caller's role.
type PrincipalFunc func(*gin.Context) (role string, ok bool)

// ActorInfo is the audit attribution of an extension operation.
type ActorInfo struct {
	UserID    string
	SiteID    string
	RequestID string
}

// ActorFunc resolves the caller for audit attribution. Optional: when nil the
// handler reads the transport principal (so production works with no extra
// wiring) and tests may inject a fixed actor.
type ActorFunc func(*gin.Context) (ActorInfo, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	// Principal resolves the caller. Nil rejects every request, which is the safe
	// default for a handler that can install server side code.
	Principal PrincipalFunc
	// Audit records install/enable/disable/remove and integrity failures (Beta 1.2
	// contract D). Nil records nothing: auditing must never be the reason an
	// extension cannot be managed.
	Audit audit.Recorder
	// Actor resolves the caller's ids for the audit row. Optional.
	Actor ActorFunc
}

// Handler serves the extension administration API.
//
// Every endpoint requires a platform administrator seat: an extension package can
// carry a WASM backend and a browser bundle, so deploying one is a deployment
// level trust decision, not a per-site setting. The authorization check lives in
// the handler rather than in a route middleware because the authentication guard
// is site scoped and this payload is not.
type Handler struct {
	service   Service
	principal PrincipalFunc
	audit     audit.Recorder
	actor     ActorFunc
}

// NewHandler builds a Handler over a Service.
func NewHandler(service Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (string, bool) { return "", false }
	}
	return &Handler{service: service, principal: principal, audit: cfg.Audit, actor: cfg.Actor}
}

// Routes mounts the extension endpoints under /api/v1.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/extensions", requireAuth)
	group.GET("", h.list)
	group.POST("/import", h.importPackage)
	group.PATCH("/:extensionID", h.setEnabled)
	group.DELETE("/:extensionID", h.remove)
}

// list returns the installed catalogue.
func (h *Handler) list(c *gin.Context) {
	if !h.authorize(c) {
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(errors.New("extension service is not configured")))
		return
	}
	items, err := h.service.List()
	if err != nil {
		_ = c.Error(apperr.Internal(err))
		return
	}
	if items == nil {
		items = []Extension{}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// importPackage accepts one multipart zip upload.
func (h *Handler) importPackage(c *gin.Context) {
	if !h.authorize(c) {
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(errors.New("extension service is not configured")))
		return
	}
	// "package" is the documented field; "file" is accepted because every other
	// upload endpoint in this API uses it.
	header, err := c.FormFile("package")
	if err != nil {
		header, err = c.FormFile("file")
	}
	if err != nil {
		_ = c.Error(apperr.Validation("a zip extension package is required").
			WithDetail("field", "package"))
		return
	}
	if header.Size <= 0 {
		_ = c.Error(apperr.Validation("the extension package is empty").
			WithDetail("field", "package"))
		return
	}
	if header.Size > MaxPackageBytes {
		_ = c.Error(apperr.Validation("the extension package exceeds 32 MiB").
			WithDetail("field", "package").
			WithDetail("reason", "package_too_large"))
		return
	}
	opened, err := header.Open()
	if err != nil {
		_ = c.Error(apperr.Internal(err))
		return
	}
	defer opened.Close()

	extension, err := h.service.ImportZip(opened, MaxPackageBytes)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	h.record(c, "extension.installed", "success", extension.ID, map[string]any{
		"version":       extension.Version,
		"manifest_hash": extension.ManifestHash,
		"integrity":     extension.Integrity,
	})
	c.JSON(http.StatusCreated, gin.H{"extension": extension})
}

// setEnabled flips one extension's enable state.
func (h *Handler) setEnabled(c *gin.Context) {
	if !h.authorize(c) {
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(errors.New("extension service is not configured")))
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	if body.Enabled == nil {
		_ = c.Error(apperr.Validation("enabled is required").WithDetail("field", "enabled"))
		return
	}
	extension, err := h.service.SetEnabled(c.Param("extensionID"), *body.Enabled)
	if err != nil {
		if errors.Is(err, plugins.ErrIntegrityMismatch) {
			// Contract D: a refused enable is an auditable integrity failure, not a
			// generic validation error. The row keeps the attempt visible even though
			// the extension state did not change to enabled.
			h.record(c, "extension.integrity_failed", "failure", c.Param("extensionID"), map[string]any{
				"reason": "manifest_integrity_mismatch",
			})
		}
		_ = c.Error(mapError(err))
		return
	}
	action := "extension.enabled"
	if !*body.Enabled {
		action = "extension.disabled"
	}
	h.record(c, action, "success", extension.ID, map[string]any{
		"state":         extension.State,
		"manifest_hash": extension.ManifestHash,
		"integrity":     extension.Integrity,
	})
	c.JSON(http.StatusOK, gin.H{"extension": extension})
}

// remove deletes one extension package.
func (h *Handler) remove(c *gin.Context) {
	if !h.authorize(c) {
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(errors.New("extension service is not configured")))
		return
	}
	if err := h.service.Remove(c.Param("extensionID")); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	h.record(c, "extension.removed", "success", c.Param("extensionID"), nil)
	c.Status(http.StatusNoContent)
}

// record writes one best effort audit row for an extension operation.
//
// Contract D freezes the action vocabulary to `extension.*`; the outcome is
// "success" unless the operation failed. Attribution comes from the optional
// Actor hook, falling back to the transport principal so a normal deployment
// needs no extra wiring. A failed audit write never fails the operation: an
// extension must stay manageable even when the database is unhappy.
func (h *Handler) record(c *gin.Context, action, outcome, targetID string, detail map[string]any) {
	if h.audit == nil {
		return
	}
	actor := ActorInfo{RequestID: middleware.RequestIDFrom(c)}
	if h.actor != nil {
		if resolved, ok := h.actor(c); ok {
			actor = resolved
			if actor.RequestID == "" {
				actor.RequestID = middleware.RequestIDFrom(c)
			}
		}
	}
	if actor.UserID == "" && actor.SiteID == "" {
		if principal, ok := middleware.PrincipalFrom(c); ok {
			actor.UserID = principal.UserID
			actor.SiteID = principal.SiteID
		}
	}
	_ = h.audit.Record(c.Request.Context(), audit.Entry{
		SiteID:    actor.SiteID,
		ActorID:   actor.UserID,
		Action:    action,
		TargetType: "extension",
		TargetID:  targetID,
		RequestID: actor.RequestID,
		Outcome:   outcome,
		Detail:    detail,
		At:        time.Now().UTC(),
	})
}

// authorize enforces the platform administrator seat.
func (h *Handler) authorize(c *gin.Context) bool {
	role, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return false
	}
	if role != "platform_admin" {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "platform_admin_required"))
		return false
	}
	return true
}

// mapError translates the manager sentinels into problem documents.
func mapError(err error) *apperr.Problem {
	switch {
	case errors.Is(err, ErrPackageTooLarge):
		return apperr.Validation("the extension package exceeds the permitted size").
			WithDetail("reason", "package_too_large").
			WithCause(err)
	case errors.Is(err, ErrInvalidPackage):
		return apperr.Validation("the uploaded file is not a valid extension package").
			WithDetail("reason", "invalid_extension_package").
			WithCause(err)
	case errors.Is(err, ErrExtensionNotFound):
		return apperr.NotFound("extension").WithCause(err)
	case errors.Is(err, plugins.ErrIntegrityMismatch):
		// 400 (not 500): the stored package is wrong, and reinstalling it is the fix.
		return apperr.Validation("the extension manifest no longer matches the hash recorded at install").
			WithDetail("reason", "manifest_integrity_mismatch").
			WithCause(err)
	default:
		var problem *apperr.Problem
		if errors.As(err, &problem) {
			return problem
		}
		return apperr.Internal(err)
	}
}
