package content

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// PrincipalFunc returns the authenticated caller's id, site and role.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// SiteFunc returns the site resolved for the request.
type SiteFunc func(*gin.Context) (site.Site, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
	// Site exposes the resolved site so public reads can be served anonymously.
	Site SiteFunc
}

// Handler exposes content authoring and moderation over HTTP.
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

// actor resolves the caller, falling back to an anonymous reader on a public site.
//
// A members-only site refuses the request outright, so the difference between the two
// visibility modes lives in exactly one place.
func (h *Handler) actor(c *gin.Context) (Actor, bool) {
	if principal, ok := h.principal(c); ok {
		return principal, true
	}

	resolved, ok := h.site(c)
	if !ok || resolved.IsMembersOnly() {
		return Actor{}, false
	}
	// The zero role carries no authority, so an anonymous reader can only ever see
	// what the service exposes to everyone.
	return Actor{SiteID: resolved.ID}, true
}

// requireActor resolves the caller or writes the rejection.
func (h *Handler) requireActor(c *gin.Context) (Actor, bool) {
	actor, ok := h.actor(c)
	if !ok {
		h.unauthenticated(c)
		return Actor{}, false
	}
	return actor, true
}

// Routes mounts the article and post endpoints under /api/v1.
//
// The two kinds share one handler: the only difference is the path segment, and
// duplicating the surface would guarantee they drift apart.
func (h *Handler) Routes(r gin.IRouter, requireAuth, optionalAuth gin.HandlerFunc) {
	for _, kind := range []Kind{KindArticle, KindPost} {
		base := "/" + string(kind) + "s"
		contentKind := kind

		// Reads are open to anonymous visitors on a public site; the handler decides
		// per request using the resolved site's visibility mode.
		r.GET(base, optionalAuth, func(c *gin.Context) { h.list(c, contentKind) })
		r.GET(base+"/:contentID", optionalAuth, h.get)

		writes := r.Group(base, requireAuth)
		writes.POST("", func(c *gin.Context) { h.create(c, contentKind) })
		writes.PATCH("/:contentID", h.update)
		writes.POST("/:contentID/:action", h.action)
	}

	// Search spans both kinds, so it lives outside the per kind groups.
	r.GET("/search", optionalAuth, h.search)
}

type contentResponse struct {
	ID            string     `json:"id"`
	Kind          string     `json:"kind"`
	Status        string     `json:"status"`
	Title         string     `json:"title"`
	Slug          string     `json:"slug"`
	Summary       string     `json:"summary"`
	SourceFormat  string     `json:"source_format"`
	RenderedHTML  string     `json:"rendered_html"`
	PolicyVersion string     `json:"policy_version"`
	CategoryID    string     `json:"category_id"`
	Tags          []string   `json:"tags"`
	PublishedAt   *time.Time `json:"published_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	Actions       []string   `json:"actions"`
}

type draftRequest struct {
	Title        string   `json:"title"`
	Slug         string   `json:"slug"`
	Summary      string   `json:"summary"`
	SourceFormat string   `json:"source_format"`
	SourceBody   string   `json:"source_body"`
	CategoryID   string   `json:"category_id"`
	Tags         []string `json:"tags"`
}

type actionRequest struct {
	Reason string `json:"reason"`
}

func (h *Handler) create(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	var req draftRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	item, err := h.service.CreateDraft(c.Request.Context(), actor, kind, toDraftInput(req))
	if err != nil && !errors.Is(err, ErrSecurityUnavailable) {
		_ = c.Error(mapError(err))
		return
	}

	// A security hold still returns the saved item, with 503 so the client retries.
	status := http.StatusCreated
	if errors.Is(err, ErrSecurityUnavailable) {
		status = http.StatusServiceUnavailable
	}
	c.JSON(status, h.view(item, actor))
}

// search returns published content matching a term.
func (h *Handler) search(c *gin.Context) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	limit := 0
	if raw := c.Query("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}

	items, err := h.service.Search(c.Request.Context(), actor, c.Query("q"), Kind(c.Query("kind")), limit)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]contentResponse, 0, len(items))
	for _, item := range items {
		views = append(views, h.view(item, actor))
	}
	c.JSON(http.StatusOK, gin.H{"items": views, "next_cursor": "", "has_more": false})
}

// parseListFilter reads the optional narrowing parameters of a listing request.
//
// Every value is validated here rather than in the store: a typo must become a 400,
// never a silently ignored filter, because an ignored filter widens the page. Absent
// values are defaults, not errors, so a plain GET /articles keeps working.
func parseListFilter(c *gin.Context) (ListFilter, error) {
	var filter ListFilter
	filter.AuthorID = strings.TrimSpace(c.Query("author_id"))

	if rawCategory := strings.TrimSpace(c.Query("category_id")); rawCategory != "" {
		if len([]rune(rawCategory)) > maxCategoryIDLength {
			return ListFilter{}, ErrInvalidInput
		}
		filter.CategoryID = rawCategory
	}

	if rawTag := strings.TrimSpace(c.Query("tag")); rawTag != "" {
		// NormalizeTag rejects quotes and backslashes, which is what keeps the JSON
		// token match in the store exact and uninjectable.
		tag := NormalizeTag(rawTag)
		if tag == "" {
			return ListFilter{}, ErrInvalidInput
		}
		filter.Tag = tag
	}

	if rawSince := strings.TrimSpace(c.Query("since")); rawSince != "" {
		since, err := time.Parse(time.RFC3339, rawSince)
		if err != nil {
			return ListFilter{}, ErrInvalidInput
		}
		filter.Since = since
	}

	sort, err := ValidateSort(c.Query("sort"))
	if err != nil {
		return ListFilter{}, err
	}
	filter.Sort = sort

	return filter, nil
}

// list returns the items of a site the caller may see.
func (h *Handler) list(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	limit := 0
	if raw := c.Query("limit"); raw != "" {
		if parsed, convErr := strconv.Atoi(raw); convErr == nil {
			limit = parsed
		}
	}

	filter, err := parseListFilter(c)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	cursor, err := page.Decode(c.Query("cursor"))
	if err != nil {
		_ = c.Error(apperr.New(apperr.CodeInvalidCursor).WithRequestID(c.GetHeader("X-Request-ID")))
		return
	}

	items, next, err := h.service.ListAfterFilter(
		c.Request.Context(),
		actor,
		kind,
		limit,
		cursor,
		filter,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]contentResponse, 0, len(items))
	for _, item := range items {
		views = append(views, h.view(item, actor))
	}

	c.JSON(http.StatusOK, gin.H{
		"items":       views,
		"next_cursor": next,
		"has_more":    next != "",
	})
}

func (h *Handler) get(c *gin.Context) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	item, err := h.service.Get(c.Request.Context(), actor, c.Param("contentID"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, h.view(item, actor))
}

func (h *Handler) update(c *gin.Context) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	var req draftRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	item, err := h.service.UpdateDraft(c.Request.Context(), actor, c.Param("contentID"), toDraftInput(req))
	if err != nil && !errors.Is(err, ErrSecurityUnavailable) {
		_ = c.Error(mapError(err))
		return
	}

	status := http.StatusOK
	if errors.Is(err, ErrSecurityUnavailable) {
		status = http.StatusServiceUnavailable
	}
	c.JSON(status, h.view(item, actor))
}

func (h *Handler) action(c *gin.Context) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	raw := c.Param("action")
	if raw == "security-retry" {
		item, err := h.service.RetrySecurityCheck(c.Request.Context(), actor, c.Param("contentID"))
		if err != nil {
			_ = c.Error(mapError(err))
			return
		}
		c.JSON(http.StatusOK, h.view(item, actor))
		return
	}

	var req actionRequest
	// The body is optional: a publish without a reason is valid.
	_ = c.ShouldBindJSON(&req)

	item, err := h.service.Apply(c.Request.Context(), actor, c.Param("contentID"), Action(raw), req.Reason)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, h.view(item, actor))
}

// view renders an item together with the actions this actor may take on it, so the
// client never has to reimplement the state machine to decide which buttons to show.
func (h *Handler) view(item Content, actor Actor) contentResponse {
	actions := make([]string, 0, 5)
	if available, err := h.service.Actions(context.Background(), actor, item); err == nil {
		for _, action := range available {
			actions = append(actions, string(action))
		}
	}

	return contentResponse{
		ID:            item.ID,
		Kind:          string(item.Kind),
		Status:        string(item.Status),
		Title:         item.Title,
		Slug:          item.Slug,
		Summary:       item.Summary,
		SourceFormat:  string(item.SourceFormat),
		RenderedHTML:  item.RenderedHTML,
		PolicyVersion: item.PolicyVersion,
		CategoryID:    item.CategoryID,
		Tags:          nonNilTags(item.Tags),
		PublishedAt:   item.PublishedAt,
		CreatedAt:     item.CreatedAt,
		UpdatedAt:     item.UpdatedAt,
		Actions:       actions,
	}
}

func (h *Handler) unauthenticated(c *gin.Context) {
	_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
}

func toDraftInput(req draftRequest) DraftInput {
	format := SourceFormat(req.SourceFormat)
	if format == "" {
		format = FormatMarkdown
	}
	return DraftInput{
		Title:        req.Title,
		Slug:         req.Slug,
		Summary:      req.Summary,
		SourceFormat: format,
		SourceBody:   req.SourceBody,
		CategoryID:   req.CategoryID,
		Tags:         req.Tags,
	}
}

// nonNilTags keeps the response shape stable: an untagged item returns [] rather
// than null, so a client can iterate without a guard.
func nonNilTags(tags []string) []string {
	if tags == nil {
		return []string{}
	}
	return tags
}

// mapError translates content failures into the API error model.
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
		return apperr.Validation("invalid content")

	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("content")

	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")

	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()

	case errors.Is(err, ErrReviewRequired):
		return apperr.Conflict(apperr.CodeContentStateInvalid).
			WithMessage("该站点要求先提交审核")

	case errors.Is(err, ErrInvalidTransition):
		return apperr.New(apperr.CodeContentStateInvalid)

	case errors.Is(err, ErrSecurityUnavailable):
		return apperr.New(apperr.CodeSecurityUnavailable)

	case errors.Is(err, ErrQuotaExceeded):
		return quotaExceededProblem()
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}

// quotaExceededProblem is the HTTP 429 projection of ErrQuotaExceeded.
//
// The stable code lives in platform/errors so clients can branch on it exactly like
// every other API error.
func quotaExceededProblem() *apperr.Problem {
	return apperr.New(apperr.CodeQuotaExceeded).WithMessage("草稿数量或草稿容量已达上限")
}
