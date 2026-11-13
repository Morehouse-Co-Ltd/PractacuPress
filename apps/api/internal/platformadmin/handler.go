package platformadmin

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// PrincipalFunc returns the authenticated caller and the site its token was issued for.
type PrincipalFunc func(*gin.Context) (userID, siteID string, ok bool)

// SiteFunc returns the site resolved for the request host.
//
// The claim endpoint needs it to prove that the handoff token was minted for this
// hostname; without that comparison a token for one tenant could mint a session on
// another tenant's origin.
type SiteFunc func(*gin.Context) (site.Site, bool)

// SessionWriter writes a full session response, cookies included.
//
// It is implemented by auth.Handler so the site handoff uses exactly the same cookie,
// CSRF and response rules as a password login. Reimplementing that here would be a
// second place to get cookie scoping wrong.
type SessionWriter interface {
	WriteSession(c *gin.Context, status int, session auth.Session)
}

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
	// Site exposes the host resolved site to the handoff claim endpoint.
	Site SiteFunc
	// Sessions is required by the handoff claim endpoint. The other endpoints do not
	// need it, so a partly wired deployment still serves the console.
	Sessions SessionWriter
}

// Handler exposes the platform console over HTTP.
type Handler struct {
	service   *Service
	principal PrincipalFunc
	site      SiteFunc
	sessions  SessionWriter
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (string, string, bool) { return "", "", false }
	}
	siteOf := cfg.Site
	if siteOf == nil {
		siteOf = func(*gin.Context) (site.Site, bool) { return site.Site{}, false }
	}
	return &Handler{
		service:   service,
		principal: principal,
		site:      siteOf,
		sessions:  cfg.Sessions,
	}
}

// Routes mounts the platform console endpoints under /api/v1.
//
// The claim endpoint is deliberately outside the authenticated group: it is reached on
// the target site's own origin, where the browser holds no session yet, and the signed
// handoff token is its credential.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	r.POST("/platform/enter/claim", h.ClaimSwitch)

	group := r.Group("/platform", requireAuth)
	group.GET("/sites", h.ListSites)
	group.POST("/sites", h.CreateSite)
	group.GET("/sites/:siteID", h.GetSite)
	group.POST("/sites/:siteID/enter", h.EnterSite)
	group.POST("/sites/:siteID/domain/verify", h.VerifySiteDomain)
	// The deployment wide reads (overview, directory, cross-site audit trail) share
	// the same authenticated group; each of them re-checks the platform seat.
	h.mountCrossSite(group)
}

// siteResponse is one site as the platform console shows it.
type siteResponse struct {
	ID             string    `json:"id"`
	Slug           string    `json:"slug"`
	Name           string    `json:"name"`
	Description    string    `json:"description"`
	Domain         string    `json:"domain"`
	DomainVerified bool      `json:"domain_verified"`
	VisibilityMode string    `json:"visibility_mode"`
	PublishMode    string    `json:"publish_mode"`
	Disabled       bool      `json:"disabled"`
	MemberCount    int       `json:"member_count"`
	AdminCount     int       `json:"admin_count"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

func toSiteResponse(summary SiteSummary) siteResponse {
	return siteResponse{
		ID:             summary.Site.ID,
		Slug:           summary.Site.Slug,
		Name:           summary.Site.Name,
		Description:    summary.Site.Description,
		Domain:         summary.Site.Domain,
		DomainVerified: summary.Site.DomainVerified(),
		VisibilityMode: string(summary.Site.VisibilityMode),
		PublishMode:    string(summary.Site.PublishMode),
		Disabled:       summary.Site.Disabled,
		MemberCount:    summary.MemberCount,
		AdminCount:     summary.AdminCount,
		CreatedAt:      summary.Site.CreatedAt.UTC(),
		UpdatedAt:      summary.Site.UpdatedAt.UTC(),
	}
}

type createSiteRequest struct {
	Name           string `json:"name"`
	Slug           string `json:"slug"`
	Description    string `json:"description"`
	Domain         string `json:"domain"`
	VisibilityMode string `json:"visibility_mode"`
	PublishMode    string `json:"publish_mode"`
	Owner          struct {
		Email       string `json:"email"`
		DisplayName string `json:"display_name"`
		Password    string `json:"password"`
	} `json:"owner"`
}

type ownerResponse struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
}

type createdSiteResponse struct {
	Site  siteResponse  `json:"site"`
	Owner ownerResponse `json:"owner"`
}

type siteDetailResponse struct {
	Site   siteResponse         `json:"site"`
	Role   string               `json:"role"`
	Domain domainStatusResponse `json:"domain_status"`
}

// domainStatusResponse is the domain challenge state of one site.
type domainStatusResponse struct {
	Domain            string `json:"domain"`
	Verified          bool   `json:"verified"`
	VerificationToken string `json:"verification_token"`
	RecordName        string `json:"record_name"`
	RecordType        string `json:"record_type"`
}

func toDomainStatusResponse(status site.DomainStatus) domainStatusResponse {
	return domainStatusResponse{
		Domain:            status.Domain,
		Verified:          status.Verified,
		VerificationToken: status.VerificationToken,
		RecordName:        status.RecordName,
		RecordType:        status.RecordType,
	}
}

// switchResponse tells the console how to reach the target site.
//
// SwitchToken is only present when switchable is true. The client appends it to the
// target site's admin URL; the token is redeemed there for a normal session.
type switchResponse struct {
	Site        siteResponse `json:"site"`
	Role        string       `json:"role"`
	Switchable  bool         `json:"switchable"`
	Reason      string       `json:"reason,omitempty"`
	SwitchToken string       `json:"switch_token,omitempty"`
	ExpiresAt   *time.Time   `json:"expires_at,omitempty"`
}

type claimRequest struct {
	SwitchToken string `json:"switch_token"`
}

// ListSites returns the sites of the deployment to a platform administrator.
func (h *Handler) ListSites(c *gin.Context) {
	userID, siteID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	summaries, err := h.service.ListSites(c.Request.Context(), siteID, userID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	items := make([]siteResponse, 0, len(summaries))
	for _, summary := range summaries {
		items = append(items, toSiteResponse(summary))
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// CreateSite creates a site, its default design and its first administrator.
func (h *Handler) CreateSite(c *gin.Context) {
	userID, siteID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	var req createSiteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	summary, owner, err := h.service.CreateSite(c.Request.Context(), siteID, userID, CreateSiteInput{
		Name:           req.Name,
		Slug:           req.Slug,
		Description:    req.Description,
		Domain:         req.Domain,
		VisibilityMode: site.VisibilityMode(req.VisibilityMode),
		PublishMode:    site.PublishMode(req.PublishMode),
		Owner: OwnerInput{
			Email:       req.Owner.Email,
			DisplayName: req.Owner.DisplayName,
			Password:    req.Owner.Password,
		},
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusCreated, createdSiteResponse{
		Site: toSiteResponse(summary),
		Owner: ownerResponse{
			UserID:      owner.ID,
			DisplayName: owner.DisplayName,
			Role:        string(site.RoleSiteAdmin),
		},
	})
}

// GetSite returns one site to a platform administrator or its own administrator.
func (h *Handler) GetSite(c *gin.Context) {
	userID, siteID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	detail, err := h.service.GetSite(c.Request.Context(), siteID, userID, c.Param("siteID"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, siteDetailResponse{
		Site:   toSiteResponse(detail.Site),
		Role:   string(detail.Role),
		Domain: toDomainStatusResponse(detail.Domain),
	})
}

// VerifySiteDomain redeems the DNS TXT challenge of a site.
//
// A newly created site is not reachable on its hostname until this succeeds, so the
// console is the only place an operator can bootstrap the site's own admin area.
func (h *Handler) VerifySiteDomain(c *gin.Context) {
	userID, siteID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	status, err := h.service.VerifyDomain(c.Request.Context(), siteID, userID, c.Param("siteID"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toDomainStatusResponse(status))
}

// EnterSite authorises the handoff to a target site.
func (h *Handler) EnterSite(c *gin.Context) {
	userID, siteID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	entry, err := h.service.EnterSite(c.Request.Context(), siteID, userID, c.Param("siteID"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	response := switchResponse{
		Site:        toSiteResponse(entry.Site),
		Role:        string(entry.Role),
		Switchable:  entry.Switchable,
		Reason:      entry.Reason,
		SwitchToken: entry.SwitchToken,
	}
	if !entry.ExpiresAt.IsZero() {
		expires := entry.ExpiresAt.UTC()
		response.ExpiresAt = &expires
	}
	c.JSON(http.StatusOK, response)
}

// ClaimSwitch redeems a handoff token on the target site's origin.
func (h *Handler) ClaimSwitch(c *gin.Context) {
	if h.sessions == nil {
		_ = c.Error(apperr.Internal(errors.New("platform: session writer is not configured")))
		return
	}

	var req claimRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	resolved, ok := h.site(c)
	if !ok {
		_ = c.Error(apperr.New(apperr.CodeSiteNotFound))
		return
	}

	session, _, err := h.service.ClaimSwitch(c.Request.Context(), resolved.ID, req.SwitchToken, auth.ClientMeta{
		UserAgent: c.GetHeader("User-Agent"),
		IPAddress: c.ClientIP(),
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	h.sessions.WriteSession(c, http.StatusOK, session)
}

// mapError translates platform failures into the API error model.
func mapError(err error) *apperr.Problem {
	var fieldErr *apperr.FieldError

	switch {
	case err == nil:
		return nil

	case errors.As(err, &fieldErr):
		return apperr.ValidationField(fieldErr.Reason, fieldErr.Field, fieldErr.Rule)

	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied().WithDetail("reason", "platform_admin_required")

	case errors.Is(err, ErrSiteNotFound), errors.Is(err, site.ErrNotFound):
		return apperr.NotFound("site")

	case errors.Is(err, ErrSlugTaken):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "slug_taken").
			WithMessage("该站点标识已经被使用")

	case errors.Is(err, ErrDomainTaken):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "domain_taken").
			WithMessage("该域名已经被其他站点使用")

	case errors.Is(err, auth.ErrIdentityExists):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "identity_exists").
			WithMessage("该邮箱已经被注册")

	case errors.Is(err, site.ErrDomainVerificationFailed):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "domain_verification_failed").
			WithMessage("域名所有权验证未通过，请检查 DNS TXT 记录后重试")

	case errors.Is(err, auth.ErrInvalidInput), errors.Is(err, site.ErrInvalidInput):
		return apperr.Validation(cleanValidation(err))

	case errors.Is(err, site.ErrDomainUnverified):
		return apperr.New(apperr.CodeSiteDomainUnverified)

	case errors.Is(err, ErrSwitchTokenInvalid):
		return apperr.Unauthenticated().WithDetail("reason", "switch_token_invalid")

	case errors.Is(err, ErrSwitchNotAllowed):
		return apperr.PermissionDenied().WithDetail("reason", "site_cannot_be_entered")

	case errors.Is(err, ErrConsoleSiteNeedsDomain):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "console_site_needs_domain").
			WithMessage("请先为当前站点配置并验证主域名，再创建其他站点；否则当前站点会失去访问入口。")

	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation(cleanValidation(err))
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}

// cleanValidation keeps validation wording short and free of internal type names.
func cleanValidation(err error) string {
	message := err.Error()
	prefixes := []string{
		"platform: invalid input: ",
		"platform: invalid input",
		"auth: invalid input: ",
		"auth: invalid input",
		"site: invalid input: ",
		"site: invalid input",
	}
	for {
		trimmed := false
		for _, prefix := range prefixes {
			if strings.HasPrefix(message, prefix) {
				message = strings.TrimPrefix(message, prefix)
				trimmed = true
			}
		}
		if !trimmed {
			break
		}
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return "invalid input"
	}
	if len([]rune(message)) > 200 {
		return "invalid input"
	}
	return message
}
