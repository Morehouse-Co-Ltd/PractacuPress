package newsletter

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

// Principal is the authenticated caller as the newsletter handler needs it.
//
// The composition root builds it from the request context. CanManageSite is the
// live membership's capability, not the role: a custom permission group may grant
// manage_site to a non administrator, and the reverse (a demoted administrator) must
// lose it immediately. Role is kept as the fallback when no membership resolver is
// wired (tests, or a deployment that still authenticates by token claim alone).
type Principal struct {
	UserID string
	SiteID string
	Role   site.Role
	// CanManageSite reports whether the live membership holds manage_site.
	CanManageSite bool
}

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Principal, bool)

// SiteFunc returns the site resolved for the request.
type SiteFunc func(*gin.Context) (site.Site, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	// Principal resolves the caller. Nil rejects every authenticated request.
	Principal PrincipalFunc
	// Site exposes the host resolved site, which supplies the site id the public
	// endpoints write to and the name templates render.
	Site SiteFunc
	// PublicBaseURL is PUBLIC_BASE_URL. It pins the origin used in mail links;
	// empty falls back to the request Host.
	PublicBaseURL string
	// Secure marks links as https when TLS terminates in front of the API.
	Secure bool
}

// Handler exposes the newsletter endpoints over HTTP.
type Handler struct {
	service       *Service
	principal     PrincipalFunc
	site          SiteFunc
	publicBaseURL string
	secure        bool
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (Principal, bool) { return Principal{}, false }
	}
	siteOf := cfg.Site
	if siteOf == nil {
		siteOf = func(*gin.Context) (site.Site, bool) { return site.Site{}, false }
	}
	return &Handler{
		service:       service,
		principal:     principal,
		site:          siteOf,
		publicBaseURL: strings.TrimRight(strings.TrimSpace(cfg.PublicBaseURL), "/"),
		secure:        cfg.Secure,
	}
}

// Routes mounts the newsletter endpoints under /api/v1.
//
// The public three are anonymous: a visitor has no account and the token is the only
// credential they will ever present. Everything else takes the site guard: the
// member switch needs a session, and the administration surface additionally checks
// manage_site inside the handler (the transport's capability matrix may not know
// these newest paths yet).
func (h *Handler) Routes(r gin.IRouter, guard gin.HandlerFunc) {
	if guard == nil {
		guard = func(c *gin.Context) {
			_ = c.Error(apperr.Unauthenticated().
				WithDetail("reason", "auth_not_configured").
				WithRequestID(c.GetHeader("X-Request-ID")))
		}
	}

	r.POST("/newsletter/subscribe", h.Subscribe)
	r.GET("/newsletter/confirm", h.Confirm)
	r.GET("/newsletter/unsubscribe", h.Unsubscribe)

	members := r.Group("/me", guard)
	members.GET("/newsletter", h.MyPreference)
	members.PUT("/newsletter", h.UpdateMyPreference)

	admin := r.Group("/sites", guard)
	admin.GET("/:siteID/subscribers", h.ListSubscribers)
	admin.DELETE("/:siteID/subscribers/:subscriberID", h.DeleteSubscriber)
	admin.GET("/:siteID/newsletter-stats", h.Stats)
	admin.GET("/:siteID/email-templates", h.ListTemplates)
	admin.PUT("/:siteID/email-templates/:key", h.SaveTemplate)
	admin.DELETE("/:siteID/email-templates/:key", h.ResetTemplate)
	admin.GET("/:siteID/email-logs", h.ListEmailLogs)
	admin.POST("/:siteID/newsletters", h.SendNewsletter)
}

// subscribeRequest is the public subscription body.
type subscribeRequest struct {
	Email  string `json:"email"`
	Source string `json:"source"`
}

// Subscribe starts the double opt in flow.
func (h *Handler) Subscribe(c *gin.Context) {
	siteInfo, ok := h.siteInfo(c)
	if !ok {
		return
	}
	var req subscribeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	result, err := h.service.Subscribe(c.Request.Context(), SubscribeInput{
		Site:        siteInfo,
		Email:       req.Email,
		Source:      req.Source,
		RequestBase: h.requestOrigin(c),
		IPHash:      HashIP(clientAddress(c)),
	})
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"status": result.Status})
}

// Confirm completes a double opt in from the mailed link.
func (h *Handler) Confirm(c *gin.Context) {
	status, err := h.service.Confirm(c.Request.Context(), c.Query("token"))
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": status})
}

// Unsubscribe opts an address out from the mailed link.
func (h *Handler) Unsubscribe(c *gin.Context) {
	status, err := h.service.Unsubscribe(c.Request.Context(), c.Query("token"))
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": status})
}

// myPreferenceResponse is the /me/newsletter payload.
type myPreferenceResponse struct {
	Subscribed bool   `json:"subscribed"`
	Email      string `json:"email"`
	Status     string `json:"status"`
}

// MyPreference returns the caller's newsletter state.
func (h *Handler) MyPreference(c *gin.Context) {
	principal, ok := h.member(c)
	if !ok {
		return
	}
	preference, err := h.service.MyPreference(c.Request.Context(), h.memberSiteID(c, principal), principal.UserID)
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, myPreferenceResponse{
		Subscribed: preference.Subscribed,
		Email:      preference.Email,
		Status:     preference.Status,
	})
}

// updatePreferenceRequest is the /me/newsletter body.
type updatePreferenceRequest struct {
	Enabled *bool `json:"enabled"`
}

// UpdateMyPreference subscribes or unsubscribes the caller's address.
func (h *Handler) UpdateMyPreference(c *gin.Context) {
	principal, ok := h.member(c)
	if !ok {
		return
	}
	var req updatePreferenceRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Enabled == nil {
		_ = c.Error(apperr.Validation("enabled is required"))
		return
	}
	siteInfo, ok := h.siteInfo(c)
	if !ok {
		return
	}
	preference, err := h.service.SetMyPreference(
		c.Request.Context(),
		siteInfo,
		principal.UserID,
		h.requestOrigin(c),
		*req.Enabled,
	)
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, myPreferenceResponse{
		Subscribed: preference.Subscribed,
		Email:      preference.Email,
		Status:     preference.Status,
	})
}

// subscriberResponse is one admin list row.
type subscriberResponse struct {
	ID             string     `json:"id"`
	Email          string     `json:"email"`
	Status         string     `json:"status"`
	Source         string     `json:"source"`
	UserID         string     `json:"user_id,omitempty"`
	ConfirmedAt    *time.Time `json:"confirmed_at,omitempty"`
	UnsubscribedAt *time.Time `json:"unsubscribed_at,omitempty"`
	LastSentAt     *time.Time `json:"last_sent_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
}

// ListSubscribers returns one page of the admin subscriber list.
func (h *Handler) ListSubscribers(c *gin.Context) {
	siteInfo, ok := h.adminSite(c)
	if !ok {
		return
	}
	cursor, ok := h.cursor(c)
	if !ok {
		return
	}
	page, err := h.service.ListSubscribers(c.Request.Context(), siteInfo.ID, SubscriberFilter{
		Status: c.Query("status"),
		Query:  c.Query("q"),
	}, queryLimit(c), cursor)
	if err != nil {
		h.fail(c, err)
		return
	}
	items := make([]subscriberResponse, 0, len(page.Items))
	for _, subscriber := range page.Items {
		items = append(items, subscriberResponse{
			ID:             subscriber.ID,
			Email:          subscriber.Email,
			Status:         subscriber.Status,
			Source:         subscriber.Source,
			UserID:         subscriber.UserID,
			ConfirmedAt:    subscriber.ConfirmedAt,
			UnsubscribedAt: subscriber.UnsubscribedAt,
			LastSentAt:     subscriber.LastSentAt,
			CreatedAt:      subscriber.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"items":       items,
		"next_cursor": page.NextCursor,
		"has_more":    page.HasMore,
	})
}

// DeleteSubscriber removes one list entry.
func (h *Handler) DeleteSubscriber(c *gin.Context) {
	siteInfo, ok := h.adminSite(c)
	if !ok {
		return
	}
	if err := h.service.DeleteSubscriber(c.Request.Context(), siteInfo.ID, c.Param("subscriberID")); err != nil {
		h.fail(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// Stats returns the dashboard counts.
func (h *Handler) Stats(c *gin.Context) {
	siteInfo, ok := h.adminSite(c)
	if !ok {
		return
	}
	stats, err := h.service.Stats(c.Request.Context(), siteInfo.ID)
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"confirmed":    stats.Confirmed,
		"pending":      stats.Pending,
		"unsubscribed": stats.Unsubscribed,
		"sent_7d":      stats.Sent7d,
		"failed_7d":    stats.Failed7d,
	})
}

// templateResponse is one template row.
type templateResponse struct {
	Key       string     `json:"key"`
	Name      string     `json:"name"`
	Subject   string     `json:"subject"`
	BodyHTML  string     `json:"body_html"`
	BodyText  string     `json:"body_text"`
	Enabled   bool       `json:"enabled"`
	Builtin   bool       `json:"builtin"`
	UpdatedAt *time.Time `json:"updated_at"`
}

// ListTemplates returns the built in defaults merged with the site's overrides.
func (h *Handler) ListTemplates(c *gin.Context) {
	siteInfo, ok := h.adminSite(c)
	if !ok {
		return
	}
	templates, err := h.service.ListTemplates(c.Request.Context(), siteInfo.ID)
	if err != nil {
		h.fail(c, err)
		return
	}
	items := make([]templateResponse, 0, len(templates))
	for _, template := range templates {
		items = append(items, toTemplateResponse(template))
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// templateRequest is one template write.
type templateRequest struct {
	Name     string `json:"name"`
	Subject  string `json:"subject"`
	BodyHTML string `json:"body_html"`
	BodyText string `json:"body_text"`
	Enabled  *bool  `json:"enabled"`
}

// SaveTemplate upserts one override.
func (h *Handler) SaveTemplate(c *gin.Context) {
	siteInfo, ok := h.adminSite(c)
	if !ok {
		return
	}
	var req templateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	template, err := h.service.SaveTemplate(c.Request.Context(), siteInfo.ID, c.Param("key"), EmailTemplateInput{
		Name:     req.Name,
		Subject:  req.Subject,
		BodyHTML: req.BodyHTML,
		BodyText: req.BodyText,
		Enabled:  req.Enabled,
	})
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, toTemplateResponse(template))
}

// ResetTemplate drops an override so the built in default is used again.
func (h *Handler) ResetTemplate(c *gin.Context) {
	siteInfo, ok := h.adminSite(c)
	if !ok {
		return
	}
	if err := h.service.ResetTemplate(c.Request.Context(), siteInfo.ID, c.Param("key")); err != nil {
		h.fail(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// emailLogResponse is one admin mail log row.
type emailLogResponse struct {
	ID          string     `json:"id"`
	ToEmail     string     `json:"to_email"`
	Kind        string     `json:"kind"`
	TemplateKey string     `json:"template_key"`
	Subject     string     `json:"subject"`
	Status      string     `json:"status"`
	Error       string     `json:"error"`
	SentAt      *time.Time `json:"sent_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

// ListEmailLogs returns one page of the admin mail log.
func (h *Handler) ListEmailLogs(c *gin.Context) {
	siteInfo, ok := h.adminSite(c)
	if !ok {
		return
	}
	cursor, ok := h.cursor(c)
	if !ok {
		return
	}
	page, err := h.service.ListEmailLogs(c.Request.Context(), siteInfo.ID, EmailLogFilter{
		Status: c.Query("status"),
		Kind:   c.Query("kind"),
	}, queryLimit(c), cursor)
	if err != nil {
		h.fail(c, err)
		return
	}
	items := make([]emailLogResponse, 0, len(page.Items))
	for _, log := range page.Items {
		items = append(items, emailLogResponse{
			ID:          log.ID,
			ToEmail:     log.ToEmail,
			Kind:        log.Kind,
			TemplateKey: log.TemplateKey,
			Subject:     log.Subject,
			Status:      log.Status,
			Error:       log.Error,
			SentAt:      log.SentAt,
			CreatedAt:   log.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"items":       items,
		"next_cursor": page.NextCursor,
		"has_more":    page.HasMore,
	})
}

// sendNewsletterRequest is the campaign body.
type sendNewsletterRequest struct {
	Subject   string `json:"subject"`
	BodyHTML  string `json:"body_html"`
	BodyText  string `json:"body_text"`
	ContentID string `json:"content_id"`
}

// SendNewsletter queues one delivery per confirmed subscriber.
func (h *Handler) SendNewsletter(c *gin.Context) {
	siteInfo, ok := h.adminSite(c)
	if !ok {
		return
	}
	var req sendNewsletterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	result, err := h.service.SendNewsletter(c.Request.Context(), SendNewsletterInput{
		Site:        siteInfo,
		Subject:     req.Subject,
		BodyHTML:    req.BodyHTML,
		BodyText:    req.BodyText,
		ContentID:   req.ContentID,
		RequestBase: h.requestOrigin(c),
	})
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"queued": result.Queued})
}

// siteInfo resolves the request's site.
func (h *Handler) siteInfo(c *gin.Context) (SiteInfo, bool) {
	resolved, ok := h.site(c)
	if !ok || strings.TrimSpace(resolved.ID) == "" {
		_ = c.Error(apperr.New(apperr.CodeSiteNotFound).
			WithRequestID(c.GetHeader("X-Request-ID")))
		return SiteInfo{}, false
	}
	return SiteInfo{ID: resolved.ID, Name: resolved.Name, Domain: resolved.Domain}, true
}

// member resolves the caller for a session scoped endpoint.
func (h *Handler) member(c *gin.Context) (Principal, bool) {
	principal, ok := h.principal(c)
	if !ok || strings.TrimSpace(principal.UserID) == "" {
		_ = c.Error(apperr.Unauthenticated().
			WithDetail("reason", "missing_principal").
			WithRequestID(c.GetHeader("X-Request-ID")))
		return Principal{}, false
	}
	return principal, true
}

// memberSiteID is the site a member scoped call acts on.
func (h *Handler) memberSiteID(c *gin.Context, principal Principal) string {
	if resolved, ok := h.site(c); ok && resolved.ID != "" {
		return resolved.ID
	}
	return principal.SiteID
}

// adminSite authorizes a manage_site call and returns the target site.
//
// The authentication guard has already validated the token; this function enforces
// the two rules the guard cannot know: the path site must be the site the request
// resolved to (a token from another tenant must not administer it) and the caller's
// live membership must hold manage_site.
func (h *Handler) adminSite(c *gin.Context) (SiteInfo, bool) {
	principal, ok := h.principal(c)
	if !ok || strings.TrimSpace(principal.UserID) == "" {
		_ = c.Error(apperr.Unauthenticated().
			WithDetail("reason", "missing_principal").
			WithRequestID(c.GetHeader("X-Request-ID")))
		return SiteInfo{}, false
	}

	siteID := c.Param("siteID")
	resolved, hasSite := h.site(c)
	if hasSite && resolved.ID != "" && resolved.ID != siteID {
		_ = c.Error(apperr.PermissionDenied().
			WithDetail("reason", "cross_site").
			WithRequestID(c.GetHeader("X-Request-ID")))
		return SiteInfo{}, false
	}
	if !hasSite && principal.SiteID != "" && principal.SiteID != siteID {
		_ = c.Error(apperr.PermissionDenied().
			WithDetail("reason", "cross_site").
			WithRequestID(c.GetHeader("X-Request-ID")))
		return SiteInfo{}, false
	}

	// The live capability is authoritative; the role is the token-only fallback for
	// deployments (and tests) without a membership resolver.
	if !principal.CanManageSite && !principal.Role.AtLeast(site.RoleSiteAdmin) {
		_ = c.Error(apperr.PermissionDenied().
			WithDetail("reason", "manage_site_required").
			WithRequestID(c.GetHeader("X-Request-ID")))
		return SiteInfo{}, false
	}

	return SiteInfo{ID: siteID, Name: resolved.Name, Domain: resolved.Domain}, true
}

// requestOrigin rebuilds the origin the browser used, mirroring the auth module:
// only the Host header is trusted, never Origin or Referer, because a mail link must
// never point at an attacker supplied host.
func (h *Handler) requestOrigin(c *gin.Context) string {
	if h.publicBaseURL != "" {
		return h.publicBaseURL
	}
	host := c.Request.Host
	if host == "" {
		return ""
	}
	if h.secure || c.Request.TLS != nil {
		return "https://" + host
	}
	return "http://" + host
}

// cursor decodes the optional pagination cursor.
func (h *Handler) cursor(c *gin.Context) (page.Cursor, bool) {
	cursor, err := page.Decode(c.Query("cursor"))
	if err != nil {
		_ = c.Error(apperr.New(apperr.CodeInvalidCursor).
			WithRequestID(c.GetHeader("X-Request-ID")))
		return page.Cursor{}, false
	}
	return cursor, true
}

// queryLimit parses the optional limit parameter.
func queryLimit(c *gin.Context) int {
	raw := strings.TrimSpace(c.Query("limit"))
	if raw == "" {
		return 0
	}
	limit, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return limit
}

// clientAddress is the raw caller address used for hashing.
//
// Gin's ClientIP already honours the engine's trusted proxy configuration; the
// plaintext value never leaves this function.
func clientAddress(c *gin.Context) string {
	if ip := strings.TrimSpace(c.ClientIP()); ip != "" {
		return ip
	}
	return c.Request.RemoteAddr
}

// toTemplateResponse projects a template.
func toTemplateResponse(template EmailTemplate) templateResponse {
	return templateResponse{
		Key:       template.Key,
		Name:      template.Name,
		Subject:   template.Subject,
		BodyHTML:  template.BodyHTML,
		BodyText:  template.BodyText,
		Enabled:   template.Enabled,
		Builtin:   template.Builtin,
		UpdatedAt: template.UpdatedAt,
	}
}

// fail maps a service error onto the API's Problem codes.
func (h *Handler) fail(c *gin.Context, err error) {
	requestID := c.GetHeader("X-Request-ID")
	switch {
	case errors.Is(err, ErrInvalidEmail), errors.Is(err, ErrInvalidSource):
		_ = c.Error(apperr.Validation("请输入有效的邮箱地址").WithRequestID(requestID))
	case errors.Is(err, ErrInvalidTemplate), errors.Is(err, ErrInvalidFilter):
		_ = c.Error(apperr.Validation("模板内容不符合要求").WithRequestID(requestID))
	case errors.Is(err, ErrAccountEmailMissing):
		_ = c.Error(apperr.Validation("当前账号没有邮箱地址").WithRequestID(requestID))
	case errors.Is(err, ErrInvalidToken):
		_ = c.Error(apperr.NotFound("订阅链接").
			WithDetail("reason", "invalid_token").
			WithRequestID(requestID))
	case errors.Is(err, ErrContentNotFound):
		_ = c.Error(apperr.NotFound("内容").
			WithDetail("reason", "content_not_found").
			WithRequestID(requestID))
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrTemplateNotFound):
		_ = c.Error(apperr.NotFound("newsletter").
			WithRequestID(requestID))
	case errors.Is(err, ErrRateLimited):
		c.Header("Retry-After", strconv.Itoa(int(SubscribeRateWindow.Seconds())))
		_ = c.Error(apperr.RateLimited().WithRequestID(requestID))
	default:
		_ = c.Error(apperr.Internal(err).WithRequestID(requestID))
	}
}
