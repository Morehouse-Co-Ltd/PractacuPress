package redirect

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (site.Member, bool)

// SiteFunc returns the site resolved from the request host.
type SiteFunc func(*gin.Context) (site.Site, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	// Principal resolves the caller of a management request.
	Principal PrincipalFunc
	// Site exposes the host-resolved site. The public resolve endpoint takes its
	// siteID from here, never from the query string, so a caller cannot resolve a path
	// against another tenant.
	Site SiteFunc
	// Now overrides the clock of the resolve cache in tests.
	Now func() time.Time
	// ResolveTTL overrides DefaultResolveTTL. Zero selects the default; a negative
	// value disables the cache, which tests use to observe every lookup.
	ResolveTTL time.Duration
	// ResolveCacheSize overrides DefaultResolveCacheSize.
	ResolveCacheSize int
}

// Handler exposes redirect rules and the public resolve endpoint over HTTP.
type Handler struct {
	service   *Service
	principal PrincipalFunc
	site      SiteFunc
	cache     *resolveCache
}

// NewHandler builds a Handler.
//
// service may be nil: the contract router mounts the routes only to compare them with
// the OpenAPI document, and no request reaches the handlers there.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (site.Member, bool) { return site.Member{}, false }
	}
	siteOf := cfg.Site
	if siteOf == nil {
		siteOf = func(*gin.Context) (site.Site, bool) { return site.Site{}, false }
	}

	ttl := cfg.ResolveTTL
	if ttl == 0 {
		ttl = DefaultResolveTTL
	}
	size := cfg.ResolveCacheSize
	if size == 0 {
		size = DefaultResolveCacheSize
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now() }
	}

	return &Handler{
		service:   service,
		principal: principal,
		site:      siteOf,
		cache:     newResolveCache(size, ttl, now),
	}
}

// Routes mounts the resolve endpoint and the site redirect management endpoints under
// /api/v1.
//
// /resolve is public on purpose: the static server calls it before serving a page and
// a crawler has no session. It still takes its site from the host-resolved request, so
// the query string cannot address another tenant. The management routes are behind the
// session guard and additionally reload the caller's site membership in the service,
// which is what enforces manage_site.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	if requireAuth == nil {
		requireAuth = func(c *gin.Context) { c.Next() }
	}

	r.GET("/resolve", h.Resolve)

	group := r.Group("/sites/:siteID/redirects")
	group.Use(requireAuth)
	group.GET("", h.List)
	group.POST("", h.Create)
	group.PATCH("/:redirectID", h.Update)
	group.DELETE("/:redirectID", h.Delete)
}

// resolveResponse is the J2 wire shape. It is an object with the six documented keys;
// content_id, slug and title are empty for a redirect or missing result.
type resolveResponse struct {
	Kind          string `json:"kind"`
	CanonicalPath string `json:"canonical_path"`
	Status        int    `json:"status"`
	ContentID     string `json:"content_id"`
	Slug          string `json:"slug"`
	Title         string `json:"title"`
}

// Resolve answers the J2 public path lookup.
func (h *Handler) Resolve(c *gin.Context) {
	resolved, ok := h.site(c)
	if !ok {
		_ = c.Error(apperr.New(apperr.CodeSiteNotFound).WithRequestID(c.GetHeader("X-Request-ID")))
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(nil))
		return
	}

	// Normalise once here so the cache key and the service call agree on the exact
	// spelling, and a query string or trailing slash cannot produce a second entry.
	normalized, err := NormalizePath(c.Query("path"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.Header("Cache-Control", h.cacheControl())

	if cached, hit := h.cache.Get(resolved.ID, normalized); hit {
		c.JSON(http.StatusOK, toResolveResponse(cached))
		return
	}

	resolution, err := h.service.ResolvePath(c.Request.Context(), resolved.ID, normalized)
	if err != nil {
		// Failures are never cached: a transient database error must not pin a 404.
		_ = c.Error(mapError(err))
		return
	}

	h.cache.Put(resolved.ID, normalized, resolution)
	c.JSON(http.StatusOK, toResolveResponse(resolution))
}

// cacheControl reports how long a resolution may be reused downstream.
func (h *Handler) cacheControl() string {
	if h.cache.ttl <= 0 || h.cache.max <= 0 {
		return "no-store"
	}
	return "public, max-age=" + strconv.Itoa(int(h.cache.ttl.Seconds()))
}

// redirectResponse is one J3 rule.
type redirectResponse struct {
	ID         string `json:"id"`
	FromPath   string `json:"from_path"`
	ToPath     string `json:"to_path"`
	StatusCode int    `json:"status_code"`
	Source     string `json:"source"`
	HitCount   int    `json:"hit_count"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

// redirectListResponse is one cursor page of rules.
type redirectListResponse struct {
	Items      []redirectResponse `json:"items"`
	NextCursor string             `json:"next_cursor"`
	HasMore    bool               `json:"has_more"`
}

// redirectRequest is the create body (RedirectRuleInput).
type redirectRequest struct {
	FromPath   string `json:"from_path"`
	ToPath     string `json:"to_path"`
	StatusCode int    `json:"status_code"`
}

// redirectPatchRequest is the update body. The document shows the same schema as
// create; pointers additionally accept a partial body without inventing a second wire
// shape, so an omitted field keeps its stored value.
type redirectPatchRequest struct {
	FromPath   *string `json:"from_path"`
	ToPath     *string `json:"to_path"`
	StatusCode *int    `json:"status_code"`
}

// List returns one page of a site's rules.
func (h *Handler) List(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}
	siteID, ok := h.scope(c)
	if !ok {
		return
	}

	limit, problem := parseLimit(c.Query("limit"))
	if problem != nil {
		_ = c.Error(problem)
		return
	}
	after, err := page.Decode(c.Query("cursor"))
	if err != nil {
		_ = c.Error(apperr.New(apperr.CodeInvalidCursor))
		return
	}

	result, err := h.service.List(c.Request.Context(), actor, siteID, c.Query("q"), limit, after)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	items := make([]redirectResponse, 0, len(result.Items))
	for _, rule := range result.Items {
		items = append(items, toResponse(rule))
	}
	c.JSON(http.StatusOK, redirectListResponse{
		Items:      items,
		NextCursor: result.NextCursor,
		HasMore:    result.HasMore,
	})
}

// Create adds a rule.
func (h *Handler) Create(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}
	siteID, ok := h.scope(c)
	if !ok {
		return
	}

	var req redirectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	rule, err := h.service.Create(c.Request.Context(), actor, siteID, Input{
		FromPath:   req.FromPath,
		ToPath:     req.ToPath,
		StatusCode: req.StatusCode,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	h.cache.Purge(siteID)
	c.JSON(http.StatusCreated, toResponse(rule))
}

// Update applies a partial change to a rule.
func (h *Handler) Update(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}
	siteID, ok := h.scope(c)
	if !ok {
		return
	}

	var req redirectPatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	rule, err := h.service.Update(c.Request.Context(), actor, siteID, c.Param("redirectID"), PatchInput{
		FromPath:   req.FromPath,
		ToPath:     req.ToPath,
		StatusCode: req.StatusCode,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	h.cache.Purge(siteID)
	c.JSON(http.StatusOK, toResponse(rule))
}

// Delete removes a rule.
func (h *Handler) Delete(c *gin.Context) {
	actor, ok := h.actor(c)
	if !ok {
		return
	}
	siteID, ok := h.scope(c)
	if !ok {
		return
	}

	if err := h.service.Delete(c.Request.Context(), actor, siteID, c.Param("redirectID")); err != nil {
		_ = c.Error(mapError(err))
		return
	}

	h.cache.Purge(siteID)
	c.Status(http.StatusNoContent)
}

// actor resolves the authenticated caller or writes the rejection.
func (h *Handler) actor(c *gin.Context) (site.Member, bool) {
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return site.Member{}, false
	}
	return actor, true
}

// scope proves the path site is the site the request host resolved to.
//
// Without it a session could address another tenant by editing the URL. The guard
// already binds the token to the resolved site; this check is what keeps the path in
// step with that binding.
func (h *Handler) scope(c *gin.Context) (string, bool) {
	siteID := c.Param("siteID")

	resolved, ok := h.site(c)
	if !ok {
		_ = c.Error(apperr.New(apperr.CodeSiteNotFound).WithRequestID(c.GetHeader("X-Request-ID")))
		return "", false
	}
	if resolved.ID != siteID {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "cross_site"))
		return "", false
	}
	return siteID, true
}

// parseLimit reads the page size. An absent value is passed on as zero, which the
// service turns into the default; anything else must be inside the documented bounds.
func parseLimit(raw string) (int, *apperr.Problem) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > MaxLimit {
		return 0, apperr.Validation("limit must be between 1 and 100").WithDetail("field", "limit")
	}
	return limit, nil
}

func toResponse(rule Redirect) redirectResponse {
	return redirectResponse{
		ID:         rule.ID,
		FromPath:   rule.FromPath,
		ToPath:     rule.ToPath,
		StatusCode: rule.StatusCode,
		Source:     string(rule.Source),
		HitCount:   rule.HitCount,
		CreatedAt:  formatTime(rule.CreatedAt),
		UpdatedAt:  formatTime(rule.UpdatedAt),
	}
}

func toResolveResponse(resolution Resolution) resolveResponse {
	return resolveResponse{
		Kind:          string(resolution.Kind),
		CanonicalPath: resolution.CanonicalPath,
		Status:        resolution.Status,
		ContentID:     resolution.ContentID,
		Slug:          resolution.Slug,
		Title:         resolution.Title,
	}
}

// formatTime renders an RFC 3339 UTC timestamp.
func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

// mapError translates redirect failures into the API error model.
func mapError(err error) *apperr.Problem {
	var fieldErr *apperr.FieldError

	switch {
	case err == nil:
		return nil

	case errors.As(err, &fieldErr):
		// The input failed a known rule: the client gets the stable field/rule pair and
		// keeps the english reason for operators.
		return apperr.ValidationField(fieldErr.Reason, fieldErr.Field, fieldErr.Rule)

	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation("invalid redirect rule")

	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("redirect rule")

	case errors.Is(err, ErrConflict):
		return apperr.Conflict(apperr.CodeConflict).
			WithMessage("a redirect rule for this path already exists")

	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")

	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}
