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
	"github.com/practacu/practacu-press/apps/api/internal/platform/textrisk"
	"github.com/practacu/practacu-press/apps/api/internal/safety"
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
	// CookieSecure marks the unlock cookie Secure. It mirrors the site cookie
	// policy so a password grant never travels over plain HTTP in production.
	CookieSecure bool
}

// Handler exposes content authoring and moderation over HTTP.
type Handler struct {
	service      *Service
	principal    PrincipalFunc
	site         SiteFunc
	cookieSecure bool
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
	return &Handler{service: service, principal: principal, site: siteOf, cookieSecure: cfg.CookieSecure}
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
		r.GET(base+"/:contentID", optionalAuth, func(c *gin.Context) { h.get(c, contentKind) })
		// The version diff is part of the history surface: author/editor only, but the
		// route still uses optional auth so an anonymous caller gets the same 401 as
		// every other content read.
		r.GET(base+"/:contentID/diff", optionalAuth, func(c *gin.Context) { h.diff(c, contentKind) })
		r.GET(base+"/:contentID/revisions", optionalAuth, func(c *gin.Context) {
			h.listRevisions(c, contentKind)
		})
		r.GET(base+"/:contentID/revisions/:revisionID", optionalAuth, func(c *gin.Context) {
			h.getRevision(c, contentKind)
		})
		// The workflow action route also serves the password unlock action. It uses
		// optional auth so an anonymous reader can unlock a password protected item;
		// every other action still calls requireActor before touching the service.
		r.POST(base+"/:contentID/:action", optionalAuth, func(c *gin.Context) {
			h.action(c, contentKind)
		})

		writes := r.Group(base, requireAuth)
		writes.POST("", func(c *gin.Context) { h.create(c, contentKind) })
		// The batch endpoint is mounted before the wildcard routes only for readability
		// of this block; the router matches the static segment first regardless.
		writes.POST("/bulk", func(c *gin.Context) { h.bulk(c, contentKind) })
		writes.PATCH("/:contentID", func(c *gin.Context) { h.update(c, contentKind) })
		// Minting a preview link is an authoring action, not a workflow move, so it is
		// spelled as its own sub-resource first.
		writes.POST("/:contentID/preview", func(c *gin.Context) { h.preview(c, contentKind) })
		// Deleting is a lifecycle move, not a workflow action, so it is spelled as the
		// HTTP method it is rather than as another entry in the action route.
		writes.DELETE("/:contentID", func(c *gin.Context) { h.trash(c, contentKind) })
		writes.POST("/:contentID/revisions/:revisionID/restore", func(c *gin.Context) {
			h.restoreRevision(c, contentKind)
		})
	}

	// Search spans both kinds, so it lives outside the per kind groups.
	r.GET("/search", optionalAuth, h.search)

	// The leaderboard spans both kinds and the whole site, so it is mounted once.
	// It is a reader surface: anonymous visitors of a public site may call it, and
	// the service only ever ranks published public items.
	r.GET("/content/popular", optionalAuth, h.popular)
}

type contentResponse struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	Status       string `json:"status"`
	Title        string `json:"title"`
	Slug         string `json:"slug"`
	Summary      string `json:"summary"`
	SourceFormat string `json:"source_format"`
	// AuthorID is the account that wrote the item. Reader surfaces such as the article
	// page resolve the display name from the public profile endpoint, so the name is
	// not duplicated here.
	AuthorID string `json:"author_id,omitempty"`
	// SourceBody is the author's original text. It is returned only to the item's
	// author and to editors: rendering it directly would bypass the sanitizer that
	// produced RenderedHTML, so anonymous readers never receive it.
	SourceBody   string `json:"source_body,omitempty"`
	RenderedHTML string `json:"rendered_html"`
	// RiskScore and RiskFlags are the rule based review signals the dashboard queue
	// ranks by (Beta 1.2). They are optional and usually absent: they exist only on
	// the moderation path, never on a reader surface. See withReviewRisk for the exact
	// conditions, and textrisk.Assess for the rules behind them.
	RiskScore     *int       `json:"risk_score,omitempty"`
	RiskFlags     []string   `json:"risk_flags,omitempty"`
	PolicyVersion string     `json:"policy_version"`
	CategoryID    string     `json:"category_id"`
	Tags          []string   `json:"tags"`
	PublishedAt   *time.Time `json:"published_at,omitempty"`
	// PublishAt is the pending publication instant of a scheduled draft.
	PublishAt *time.Time `json:"publish_at,omitempty"`
	// AccessMode, HasAccessPassword and CommentPolicy describe the item's access
	// and comment rules. The password hash itself is never serialized.
	AccessMode        string `json:"access_mode"`
	HasAccessPassword bool   `json:"has_access_password"`
	CommentPolicy     string `json:"comment_policy"`
	// ViewCount is the de-duplicated read counter (FSD A-16). Lists carry it so the
	// archive can show it without a second request per item.
	ViewCount int       `json:"view_count"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Actions   []string  `json:"actions"`
	// Revision is the current version number, used by the editor to address the
	// history entries this state belongs to.
	Revision int `json:"revision"`
	// DeletedAt marks an item in the recycle bin. It is present only for a trashed
	// item, so a client can render the bin from the same view it uses everywhere else.
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
	// The SEO and cover overrides. An empty value means "inherit the site template",
	// which is what an item that never touched them reports.
	SeoTitle       string `json:"seo_title"`
	SeoDescription string `json:"seo_description"`
	SeoKeywords    string `json:"seo_keywords"`
	CanonicalURL   string `json:"canonical_url"`
	OgImage        string `json:"og_image"`
	Robots         string `json:"robots"`
	CoverURL       string `json:"cover_url"`
	CoverAlt       string `json:"cover_alt"`
	CoverPosition  string `json:"cover_position"`
	CoverHidden    bool   `json:"cover_hidden"`
}

// revisionSummary is the list projection of a history entry. The source body is
// deliberately absent: the list is bounded but the bodies are not, so a caller
// fetches one revision to read or compare it.
type revisionSummary struct {
	ID           string    `json:"id"`
	ContentID    string    `json:"content_id"`
	Version      int       `json:"version"`
	EditorID     string    `json:"editor_id"`
	EditorName   string    `json:"editor_name,omitempty"`
	Action       string    `json:"action"`
	Status       string    `json:"status"`
	Title        string    `json:"title"`
	Slug         string    `json:"slug"`
	Summary      string    `json:"summary"`
	SourceFormat string    `json:"source_format"`
	CategoryID   string    `json:"category_id"`
	Tags         []string  `json:"tags"`
	CreatedAt    time.Time `json:"created_at"`
}

// revisionResponse is the detail projection, including the raw source needed to
// inspect or diff one version.
type revisionResponse struct {
	revisionSummary
	SourceBody    string `json:"source_body"`
	RenderedHTML  string `json:"rendered_html"`
	PolicyVersion string `json:"policy_version"`
}

type draftRequest struct {
	Title        string   `json:"title"`
	Slug         string   `json:"slug"`
	Summary      string   `json:"summary"`
	SourceFormat string   `json:"source_format"`
	SourceBody   string   `json:"source_body"`
	CategoryID   string   `json:"category_id"`
	Tags         []string `json:"tags"`
	// PublishAt is an RFC 3339 instant. Omitted or empty removes a pending schedule.
	PublishAt  string `json:"publish_at"`
	AccessMode string `json:"access_mode"`
	// AccessPassword is write only: an empty value keeps the stored hash.
	AccessPassword string `json:"access_password"`
	CommentPolicy  string `json:"comment_policy"`
	// The SEO and cover overrides use replace semantics: the client sends the whole
	// table on every save, and an empty value clears the override so the site
	// template applies again.
	SeoTitle       string `json:"seo_title"`
	SeoDescription string `json:"seo_description"`
	SeoKeywords    string `json:"seo_keywords"`
	CanonicalURL   string `json:"canonical_url"`
	OgImage        string `json:"og_image"`
	Robots         string `json:"robots"`
	CoverURL       string `json:"cover_url"`
	CoverAlt       string `json:"cover_alt"`
	CoverPosition  string `json:"cover_position"`
	CoverHidden    bool   `json:"cover_hidden"`
	// Revision is the optional optimistic concurrency token (contract F). Omitted
	// keeps last-write-wins; a stale value is answered with 409
	// content_version_conflict and details.current_revision.
	Revision *int `json:"revision"`
}

type unlockRequest struct {
	Password string `json:"password"`
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
	input, err := toDraftInput(req)
	if err != nil {
		_ = c.Error(apperr.ValidationField("malformed publish_at", "publish_at", "malformed"))
		return
	}

	item, err := h.service.CreateDraft(c.Request.Context(), actor, kind, input)
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

// searchHitResponse is one search result plus its optional plain text snippet.
// The snippet is deliberately not HTML: the client escapes it and applies its
// own highlighting, so no search term can inject markup.
type searchHitResponse struct {
	contentResponse
	Snippet string `json:"snippet,omitempty"`
}

// searchResponse is the search page. total is the count across every page, so
// the client can show "found N results" while paging with the cursor.
type searchResponse struct {
	Items      []searchHitResponse `json:"items"`
	Total      int                 `json:"total"`
	NextCursor string              `json:"next_cursor"`
	HasMore    bool                `json:"has_more"`
	// Degraded reports that the full text index was unavailable and the server
	// answered with the portable LIKE fallback.
	Degraded bool `json:"degraded,omitempty"`
}

// search returns published public content matching a term.
func (h *Handler) search(c *gin.Context) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	query, err := parseSearchQuery(c)
	if err != nil {
		if errors.Is(err, page.ErrInvalidCursor) {
			_ = c.Error(apperr.New(apperr.CodeInvalidCursor).WithRequestID(c.GetHeader("X-Request-ID")))
			return
		}
		_ = c.Error(mapError(err))
		return
	}

	result, err := h.service.Search(c.Request.Context(), actor, query)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]searchHitResponse, 0, len(result.Hits))
	for _, hit := range result.Hits {
		views = append(views, searchHitResponse{
			contentResponse: h.view(hit.Content, actor),
			Snippet:         hit.Snippet,
		})
	}

	c.JSON(http.StatusOK, searchResponse{
		Items:      views,
		Total:      result.Total,
		NextCursor: result.NextCursor,
		HasMore:    result.NextCursor != "",
		Degraded:   result.Degraded,
	})
}

// parseSearchQuery reads and validates the search query parameters.
//
// It is the same philosophy as parseListFilter: a malformed narrowing value is
// a 400, never a silently dropped filter, because dropping it would widen the
// result set behind the caller's back.
func parseSearchQuery(c *gin.Context) (SearchQuery, error) {
	query := SearchQuery{
		Term: strings.TrimSpace(c.Query("q")),
		Kind: Kind(strings.TrimSpace(c.Query("kind"))),
		// Highlight defaults on; only an explicit false disables the snippet.
		Highlight: true,
	}
	if query.Kind != "" && !query.Kind.Valid() {
		return SearchQuery{}, ErrInvalidInput
	}

	if rawLimit := strings.TrimSpace(c.Query("limit")); rawLimit != "" {
		limit, err := strconv.Atoi(rawLimit)
		if err != nil {
			return SearchQuery{}, ErrInvalidInput
		}
		query.Limit = limit
	}

	cursor, err := page.Decode(c.Query("cursor"))
	if err != nil {
		return SearchQuery{}, err
	}
	query.After = cursor

	if rawCategory := strings.TrimSpace(c.Query("category_id")); rawCategory != "" {
		if len([]rune(rawCategory)) > maxCategoryIDLength {
			return SearchQuery{}, ErrInvalidInput
		}
		query.CategoryID = rawCategory
	}
	if rawTag := strings.TrimSpace(c.Query("tag")); rawTag != "" {
		tag := NormalizeTag(rawTag)
		if tag == "" {
			return SearchQuery{}, ErrInvalidInput
		}
		query.Tag = tag
	}
	query.AuthorID = strings.TrimSpace(c.Query("author_id"))

	if rawSince := strings.TrimSpace(c.Query("since")); rawSince != "" {
		since, parseErr := time.Parse(time.RFC3339, rawSince)
		if parseErr != nil {
			return SearchQuery{}, ErrInvalidInput
		}
		query.Since = since
	}
	if rawUntil := strings.TrimSpace(c.Query("until")); rawUntil != "" {
		until, parseErr := time.Parse(time.RFC3339, rawUntil)
		if parseErr != nil {
			return SearchQuery{}, ErrInvalidInput
		}
		query.Until = until
	}
	if !query.Until.IsZero() && !query.Since.IsZero() && query.Until.Before(query.Since) {
		return SearchQuery{}, ErrInvalidInput
	}

	switch strings.ToLower(strings.TrimSpace(c.Query("highlight"))) {
	case "0", "false", "off", "no":
		query.Highlight = false
	}

	return query, nil
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

	if raw := strings.TrimSpace(c.Query("trashed")); raw != "" {
		// Parsed strictly: a typo must be a 400 like every other narrowing value. A
		// silently ignored value here would answer the live listing to a client that
		// asked for the recycle bin.
		trashed, convErr := strconv.ParseBool(raw)
		if convErr != nil {
			return ListFilter{}, ErrInvalidInput
		}
		filter.Trashed = trashed
	}

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
		// The listing is the queue's read path, so it is one of the two places that
		// may carry the review risk fields; reviewView leaves them out for every row
		// the caller may not moderate or that is not waiting for review.
		views = append(views, h.reviewView(item, actor))
	}

	c.JSON(http.StatusOK, gin.H{
		"items":       views,
		"next_cursor": next,
		"has_more":    next != "",
	})
}

// resolveContentID maps the route's {contentID} parameter to the stored id.
//
// The contract (J1) allows a slug wherever an id was accepted before, so the value a
// route hands the service is always an id. A key that resolves to nothing is answered
// as a missing resource, never as a permission error, so a client cannot probe what
// exists on the site.
//
// includeTrashed is set by the endpoints whose key may legitimately address the
// recycle bin (DELETE is idempotent and undelete/purge operate on the bin).
func (h *Handler) resolveContentID(c *gin.Context, actor Actor, kind Kind, includeTrashed bool) (string, bool) {
	key := c.Param("contentID")
	var (
		contentID string
		err       error
	)
	if includeTrashed {
		contentID, err = h.service.ResolveActionContentID(c.Request.Context(), actor.SiteID, kind, key)
	} else {
		contentID, err = h.service.ResolveContentID(c.Request.Context(), actor.SiteID, kind, key)
	}
	if err != nil {
		_ = c.Error(mapError(err))
		return "", false
	}
	return contentID, true
}

func (h *Handler) get(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}
	contentID, ok := h.resolveContentID(c, actor, kind, false)
	if !ok {
		return
	}

	// A valid preview token lets its holder read an unpublished draft; an invalid or
	// expired one is not an error, the request simply falls back to the ordinary read
	// and an unpublished item therefore answers 404.
	item, err := h.service.ReadWithPreview(
		c.Request.Context(),
		actor,
		contentID,
		strings.TrimSpace(c.Query("preview_token")),
		h.unlocked(c, actor, contentID),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	// A moderator opening one item is the other half of the queue path, so the same
	// review-only fields are offered here; readers and authors never receive them.
	c.JSON(http.StatusOK, h.reviewView(item, actor))

	// Counting runs after the body has been rendered: the response is already the
	// complete read, and a counter that fails must not turn it into an error. This
	// is the only place a read is counted, so one request can never add two views.
	h.recordView(c, actor, item)
}

// recordView counts one read of a published item.
//
// Best effort on purpose: the error is dropped, because the reader already got the
// content and a lost count is not something a reader should ever see. The caller is
// not told either: a self read (the author or an editor) is not a reader.
func (h *Handler) recordView(c *gin.Context, actor Actor, item Content) {
	if item.Status != StatusPublished {
		// A draft opened by its author is not a read of published content, and the
		// store would refuse it anyway.
		return
	}
	selfView := item.IsAuthor(actor) || actor.Role.AtLeast(site.RoleEditor)
	_ = h.service.RecordView(c.Request.Context(), ViewInput{
		SiteID:    item.SiteID,
		ContentID: item.ID,
		UserID:    actor.UserID,
		// The browser sends the same random session id it reports to the visit
		// endpoint, so a reload or a second tab inside the window counts once. It is
		// a de-duplication hint, never an identity.
		Session:  c.GetHeader("X-Visit-Session"),
		IP:       c.ClientIP(),
		SelfView: selfView,
	})
}

// popularResponse is one page of the leaderboard.
type popularResponse struct {
	Items []contentResponse `json:"items"`
	// Window echoes the resolved ranking horizon so a client can label the board.
	Window string `json:"window"`
}

// popular returns the site's most read content, decayed by publication age.
func (h *Handler) popular(c *gin.Context) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	query, err := parsePopularQuery(c)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	items, err := h.service.Popular(c.Request.Context(), actor, query)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]contentResponse, 0, len(items))
	for _, item := range items {
		views = append(views, h.view(item.Content, actor))
	}

	window, _ := ParsePopularWindow(query.Window)
	c.JSON(http.StatusOK, popularResponse{Items: views, Window: window})
}

// parsePopularQuery reads and validates the leaderboard parameters.
//
// Same philosophy as the listing: a malformed narrowing value is a 400, never a
// silently dropped filter, because dropping it would widen the board behind the
// caller's back.
func parsePopularQuery(c *gin.Context) (PopularQuery, error) {
	query := PopularQuery{
		Kind: Kind(strings.TrimSpace(c.Query("kind"))),
	}
	if query.Kind != "" && !query.Kind.Valid() {
		return PopularQuery{}, ErrInvalidInput
	}

	window, err := ParsePopularWindow(c.Query("window"))
	if err != nil {
		return PopularQuery{}, err
	}
	query.Window = window

	if rawLimit := strings.TrimSpace(c.Query("limit")); rawLimit != "" {
		limit, convErr := strconv.Atoi(rawLimit)
		if convErr != nil {
			return PopularQuery{}, ErrInvalidInput
		}
		query.Limit = limit
	}

	if rawCategory := strings.TrimSpace(c.Query("category_id")); rawCategory != "" {
		if len([]rune(rawCategory)) > maxCategoryIDLength {
			return PopularQuery{}, ErrInvalidInput
		}
		query.CategoryID = rawCategory
	}
	if rawTag := strings.TrimSpace(c.Query("tag")); rawTag != "" {
		tag := NormalizeTag(rawTag)
		if tag == "" {
			return PopularQuery{}, ErrInvalidInput
		}
		query.Tag = tag
	}

	return query, nil
}

// unlocked reports whether this request carries a valid session grant for the item.
//
// The grant is an HttpOnly cookie minted by the unlock action; an absent or invalid
// cookie simply means the reader has not unlocked the item in this session.
func (h *Handler) unlocked(c *gin.Context, actor Actor, contentID string) bool {
	token, err := c.Cookie(unlockCookieName(contentID))
	if err != nil || token == "" {
		return false
	}
	return h.service.VerifyUnlock(c.Request.Context(), token, actor.SiteID, contentID)
}

// unlock verifies the item password and stores the session grant in a cookie.
func (h *Handler) unlock(c *gin.Context, kind Kind) {
	actor, ok := h.actor(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	contentID, ok := h.resolveContentID(c, actor, kind, false)
	if !ok {
		return
	}

	var req unlockRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	grant, err := h.service.Unlock(
		c.Request.Context(), actor, contentID, req.Password, c.ClientIP(),
	)
	if err != nil {
		var locked *UnlockLockedError
		if errors.As(err, &locked) {
			seconds := int(locked.RetryAfter.Seconds())
			if seconds < 1 {
				seconds = 1
			}
			c.Header("Retry-After", strconv.Itoa(seconds))
		}
		_ = c.Error(mapError(err))
		return
	}

	http.SetCookie(c.Writer, &http.Cookie{
		Name:     unlockCookieName(contentID),
		Value:    grant.Token,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		Expires:  grant.ExpiresAt,
	})
	c.JSON(http.StatusOK, gin.H{"unlocked": true, "expires_at": grant.ExpiresAt})
}

// unlockCookieName scopes one grant per item. Content ids are UUIDs, so the name is
// always a valid cookie token.
func unlockCookieName(contentID string) string {
	return "pp_unlock_" + contentID
}

// trash moves an item into the recycle bin.
//
// The response carries the stored item rather than an empty body, so the client can
// switch the row straight to its trashed state (deleted_at plus the two lifecycle
// actions) without a second read.
func (h *Handler) trash(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}
	// Trashing is idempotent, so a key that addresses an already trashed item still
	// resolves here.
	contentID, ok := h.resolveContentID(c, actor, kind, true)
	if !ok {
		return
	}

	item, err := h.service.Trash(c.Request.Context(), actor, contentID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, h.view(item, actor))
}

func (h *Handler) update(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}
	contentID, ok := h.resolveContentID(c, actor, kind, false)
	if !ok {
		return
	}

	var req draftRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	input, err := toDraftInput(req)
	if err != nil {
		_ = c.Error(apperr.ValidationField("malformed publish_at", "publish_at", "malformed"))
		return
	}

	item, err := h.service.UpdateDraft(c.Request.Context(), actor, contentID, input)
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

func (h *Handler) action(c *gin.Context, kind Kind) {
	raw := c.Param("action")
	// Unlock is the one action an anonymous reader may perform: it turns the access
	// password into a session grant for a password protected item.
	if raw == "unlock" {
		h.unlock(c, kind)
		return
	}

	actor, ok := h.requireActor(c)
	if !ok {
		return
	}
	contentID, ok := h.resolveContentID(c, actor, kind, true)
	if !ok {
		return
	}

	if raw == "security-retry" {
		item, err := h.service.RetrySecurityCheck(c.Request.Context(), actor, contentID)
		if err != nil {
			_ = c.Error(mapError(err))
			return
		}
		c.JSON(http.StatusOK, h.view(item, actor))
		return
	}

	switch Action(raw) {
	case ActionUndelete:
		item, err := h.service.Undelete(c.Request.Context(), actor, contentID)
		if err != nil {
			_ = c.Error(mapError(err))
			return
		}
		c.JSON(http.StatusOK, h.view(item, actor))
		return

	case ActionPurge:
		if err := h.service.Purge(c.Request.Context(), actor, contentID); err != nil {
			_ = c.Error(mapError(err))
			return
		}
		// Nothing of the item is left to describe, so the response says exactly that:
		// a body here would have to be invented from data the caller just destroyed.
		c.Status(http.StatusNoContent)
		return
	}

	var req actionRequest
	// The body is optional: a publish without a reason is valid.
	_ = c.ShouldBindJSON(&req)

	item, err := h.service.Apply(c.Request.Context(), actor, contentID, Action(raw), req.Reason)
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

	response := contentResponse{
		ID:                item.ID,
		Kind:              string(item.Kind),
		Status:            string(item.Status),
		Title:             item.Title,
		Slug:              item.Slug,
		Summary:           item.Summary,
		SourceFormat:      string(item.SourceFormat),
		AuthorID:          item.AuthorID,
		RenderedHTML:      item.RenderedHTML,
		PolicyVersion:     item.PolicyVersion,
		CategoryID:        item.CategoryID,
		Tags:              nonNilTags(item.Tags),
		PublishedAt:       item.PublishedAt,
		PublishAt:         item.PublishAt,
		AccessMode:        string(item.AccessMode),
		HasAccessPassword: item.AccessPasswordHash != "",
		CommentPolicy:     string(item.CommentPolicy),
		ViewCount:         item.ViewCount,
		CreatedAt:         item.CreatedAt,
		UpdatedAt:         item.UpdatedAt,
		Actions:           actions,
		Revision:          item.Revision,
		DeletedAt:         item.DeletedAt,
		SeoTitle:          item.SeoTitle,
		SeoDescription:    item.SeoDescription,
		SeoKeywords:       item.SeoKeywords,
		CanonicalURL:      item.CanonicalURL,
		OgImage:           item.OgImage,
		Robots:            string(item.Robots),
		CoverURL:          item.CoverURL,
		CoverAlt:          item.CoverAlt,
		CoverPosition:     string(item.CoverPosition),
		CoverHidden:       item.CoverHidden,
	}
	// The raw source is an editing aid, not public content. A published item is
	// readable anonymously, so the field is gated on write access rather than on
	// read access; otherwise a reader could render the pre-sanitized markup.
	if item.IsAuthor(actor) || actor.Role.AtLeast(site.RoleEditor) {
		response.SourceBody = item.SourceBody
	}
	return response
}

// reviewView renders an item for the moderation queue: the shared projection plus the
// two review-only risk fields, when this caller is allowed to see them.
func (h *Handler) reviewView(item Content, actor Actor) contentResponse {
	return withReviewRisk(item, actor, h.view(item, actor))
}

// withReviewRisk fills risk_score and risk_flags for a response, and is the only place
// that writes them.
//
// It is deliberately not part of view(): view() projects every read path - the public
// article page, the archive listing, search, the leaderboard - and an article body is
// up to MaxSourceLength characters. Scoring each row there would slow down readers for
// a number no reader may see. Only the two call sites a moderator actually reads opt
// in (list and get), and even there both fields appear only when all three conditions
// hold:
//
//   - the caller can moderate, the same authority that approves a pending item
//     (authorizeAction) and that unlocks the raw source next to these fields;
//   - the item is still waiting for review, i.e. pending_review or
//     pending_security_check - a published item is no longer the queue's business,
//     and scoring the published archive is exactly the cost this design avoids;
//   - the source body is available to score, which is the body the author wrote.
//
// Every other response keeps both fields absent (omitempty on a nil pointer and a nil
// slice), so a public reader, the author of the item and every published listing see
// byte for byte the payload they saw before. The score is computed here rather than
// stored: an article is edited far more often than it is reviewed, and a derived value
// that is only ever read on one screen does not need a column, a migration and a
// backfill to rot in.
func withReviewRisk(item Content, actor Actor, response contentResponse) contentResponse {
	if !canModerateContent(actor) || !awaitingReview(item.Status) || item.SourceBody == "" {
		return response
	}
	score, flags := textrisk.Assess(item.SourceBody)
	response.RiskScore = &score
	response.RiskFlags = flags
	return response
}

// canModerateContent reports whether the actor holds the moderation authority the
// review queue requires.
//
// It reads the same two sources the rest of the package does: the role gate that
// authorizeAction and the source body projection use, and the capability matrix that
// the transport guard enforces on every moderation endpoint. The built-in editor group
// is exactly the group that carries moderate_content, so the two answers agree today
// and stay in agreement if the default matrix is ever re-tuned.
func canModerateContent(actor Actor) bool {
	if actor.Role.AtLeast(site.RoleEditor) {
		return true
	}
	return site.DefaultCapabilities(actor.Role).Allows(site.CapabilityModerateContent)
}

// awaitingReview reports whether the item is waiting for a moderation decision, which
// is the only kind of state the queue scores.
func awaitingReview(status Status) bool {
	return status == StatusPendingReview || status == StatusPendingSecurityCheck
}

// listRevisions returns the bounded history of one item.
func (h *Handler) listRevisions(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}
	contentID, ok := h.resolveContentID(c, actor, kind, false)
	if !ok {
		return
	}

	revisions, err := h.service.ListRevisions(c.Request.Context(), actor, contentID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	views := make([]revisionSummary, 0, len(revisions))
	for _, revision := range revisions {
		views = append(views, toRevisionSummary(revision))
	}
	c.JSON(http.StatusOK, gin.H{"items": views})
}

// getRevision returns one history entry including its raw source.
func (h *Handler) getRevision(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}
	contentID, ok := h.resolveContentID(c, actor, kind, false)
	if !ok {
		return
	}

	revision, err := h.service.GetRevision(
		c.Request.Context(), actor, contentID, c.Param("revisionID"),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toRevisionResponse(revision))
}

// restoreRevision rolls the item back to a history entry.
func (h *Handler) restoreRevision(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}
	contentID, ok := h.resolveContentID(c, actor, kind, false)
	if !ok {
		return
	}

	item, err := h.service.RestoreRevision(
		c.Request.Context(), actor, contentID, c.Param("revisionID"),
	)
	if err != nil && !errors.Is(err, ErrSecurityUnavailable) {
		_ = c.Error(mapError(err))
		return
	}

	// A failed sanitization leaves an unpublished item held, but still returns the
	// saved state so the author keeps the restored text.
	status := http.StatusOK
	if errors.Is(err, ErrSecurityUnavailable) {
		status = http.StatusServiceUnavailable
	}
	c.JSON(status, h.view(item, actor))
}

// diff returns the line diff between two versions of one item (contract E).
func (h *Handler) diff(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}
	contentID, ok := h.resolveContentID(c, actor, kind, false)
	if !ok {
		return
	}

	result, err := h.service.Diff(
		c.Request.Context(), actor, contentID, c.Query("from"), c.Query("to"),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, result)
}

// bulkRequest is the batch action payload (contract G).
type bulkRequest struct {
	IDs    []string `json:"ids"`
	Action string   `json:"action"`
}

// bulk applies one action to many items and reports the outcome of each.
//
// A request that is malformed as a whole is a 400; a batch where some items were
// refused is still a 200 with the per item failures inside, which is the contract.
func (h *Handler) bulk(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}

	var req bulkRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	result, err := h.service.Bulk(c.Request.Context(), actor, kind, req.IDs, req.Action)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, result)
}

// preview mints a draft preview link for one item (contract H).
func (h *Handler) preview(c *gin.Context, kind Kind) {
	actor, ok := h.requireActor(c)
	if !ok {
		return
	}
	contentID, ok := h.resolveContentID(c, actor, kind, false)
	if !ok {
		return
	}

	grant, err := h.service.IssuePreview(c.Request.Context(), actor, contentID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, grant)
}

func toRevisionSummary(revision Revision) revisionSummary {
	return revisionSummary{
		ID:           revision.ID,
		ContentID:    revision.ContentID,
		Version:      revision.Version,
		EditorID:     revision.EditorID,
		EditorName:   revision.EditorName,
		Action:       string(revision.Action),
		Status:       string(revision.Status),
		Title:        revision.Title,
		Slug:         revision.Slug,
		Summary:      revision.Summary,
		SourceFormat: string(revision.SourceFormat),
		CategoryID:   revision.CategoryID,
		Tags:         nonNilTags(revision.Tags),
		CreatedAt:    revision.CreatedAt,
	}
}

func toRevisionResponse(revision Revision) revisionResponse {
	return revisionResponse{
		revisionSummary: toRevisionSummary(revision),
		SourceBody:      revision.SourceBody,
		RenderedHTML:    revision.RenderedHTML,
		PolicyVersion:   revision.PolicyVersion,
	}
}

func (h *Handler) unauthenticated(c *gin.Context) {
	_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
}

func toDraftInput(req draftRequest) (DraftInput, error) {
	format := SourceFormat(req.SourceFormat)
	if format == "" {
		format = FormatMarkdown
	}
	input := DraftInput{
		Title:          req.Title,
		Slug:           req.Slug,
		Summary:        req.Summary,
		SourceFormat:   format,
		SourceBody:     req.SourceBody,
		CategoryID:     req.CategoryID,
		Tags:           req.Tags,
		AccessMode:     AccessMode(strings.TrimSpace(req.AccessMode)),
		AccessPassword: req.AccessPassword,
		CommentPolicy:  CommentPolicy(strings.TrimSpace(req.CommentPolicy)),
		SeoTitle:       req.SeoTitle,
		SeoDescription: req.SeoDescription,
		SeoKeywords:    req.SeoKeywords,
		CanonicalURL:   req.CanonicalURL,
		OgImage:        req.OgImage,
		Robots:         Robots(strings.TrimSpace(req.Robots)),
		CoverURL:       req.CoverURL,
		CoverAlt:       req.CoverAlt,
		CoverPosition:  CoverPosition(strings.TrimSpace(req.CoverPosition)),
		CoverHidden:    req.CoverHidden,
		// The concurrency token travels with the request, not the form body.
		Revision: req.Revision,
	}
	if raw := strings.TrimSpace(req.PublishAt); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return DraftInput{}, err
		}
		input.PublishAt = &parsed
	}
	return input, nil
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
	var versionConflict *VersionConflictError

	switch {
	case err == nil:
		return nil

	case errors.As(err, &versionConflict):
		// A stale revision token is the one conflict the client can resolve on its
		// own: it reloads the item and retries with the current revision.
		return versionConflictProblem(versionConflict.Current)

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

	case errors.Is(err, ErrPasswordRequired):
		return apperr.PermissionDenied().WithDetail("reason", "password_required")

	case errors.Is(err, ErrMembersOnly):
		return apperr.Unauthenticated().WithDetail("reason", "members_only")

	case errors.Is(err, ErrInvalidPassword):
		return apperr.PermissionDenied().WithDetail("reason", "invalid_password")

	case errors.Is(err, ErrUnlockLocked):
		return apperr.RateLimited().WithDetail("reason", "unlock_locked")

	case errors.Is(err, ErrPasswordNotSet), errors.Is(err, ErrAccessPasswordRequired):
		return apperr.ValidationField("access password is required", "access_password", "required")

	case errors.Is(err, ErrScheduleNotAllowed):
		return apperr.PermissionDenied().WithDetail("reason", "schedule_not_allowed")

	case errors.Is(err, ErrReviewRequired):
		return apperr.Conflict(apperr.CodeContentStateInvalid).
			WithMessage("该站点要求先提交审核")

	case errors.Is(err, ErrInvalidTransition):
		return apperr.New(apperr.CodeContentStateInvalid)

	case errors.Is(err, ErrConflict):
		// The item changed after this request read it: the client re-reads and
		// retries instead of overwriting the newer revision.
		return apperr.Conflict(apperr.CodeConflict)

	case errors.Is(err, ErrSecurityUnavailable):
		return apperr.New(apperr.CodeSecurityUnavailable)

	case errors.Is(err, ErrPreviewUnavailable):
		// Preview signing was not wired into this deployment. That is an operational
		// gap, not a client error, so it is reported as temporarily unavailable.
		return apperr.New(apperr.CodeSecurityUnavailable).
			WithMessage("草稿预览暂不可用，请稍后重试")

	case errors.Is(err, ErrQuotaExceeded):
		return quotaExceededProblem()

	case errors.Is(err, safety.ErrRejected):
		// The matched words stay server side; the client only learns that the site's
		// content policy refused the submission.
		return apperr.PermissionDenied().WithDetail("reason", "sensitive_word")
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

// versionConflictProblem renders the contract F 409 body.
//
// The code is registered in platform/errors, so the status, title and message all
// come from the one shared table instead of being restated here; only the current
// revision travels as a detail.
func versionConflictProblem(current int) *apperr.Problem {
	return apperr.New(apperr.CodeContentVersionConflict).
		WithDetail("current_revision", current)
}
