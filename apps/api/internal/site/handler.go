package site

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller's account and the site its access
// token was issued for.
//
// The token site is compared with the site in the path: a token minted on site A
// must not administer site B, where the same account may hold a different role.
// It is injected so this package does not depend on the HTTP middleware package.
type PrincipalFunc func(*gin.Context) (userID, siteID string, ok bool)

// SiteFunc returns the site resolved for the request.
//
// The public author profile needs it to apply the site's visibility mode without
// depending on the HTTP middleware package.
type SiteFunc func(*gin.Context) (Site, bool)

// RequestIDFunc returns the request correlation id.
type RequestIDFunc func(*gin.Context) string

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
	// Site exposes the resolved site so public reads can honour its visibility mode.
	Site      SiteFunc
	RequestID RequestIDFunc
	// Contact delivers contact form submissions to the site's administrators. When it
	// is nil the route still exists (the contract documents it) but answers 500: a
	// deployment that never wired a notifier must not silently swallow messages.
	Contact *ContactService
}

// Handler exposes site administration over HTTP.
type Handler struct {
	service   *Service
	principal PrincipalFunc
	site      SiteFunc
	requestID RequestIDFunc
	contact   *ContactService
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (string, string, bool) { return "", "", false }
	}
	siteOf := cfg.Site
	if siteOf == nil {
		siteOf = func(*gin.Context) (Site, bool) { return Site{}, false }
	}
	requestID := cfg.RequestID
	if requestID == nil {
		requestID = func(*gin.Context) string { return "" }
	}
	return &Handler{
		service:   service,
		principal: principal,
		site:      siteOf,
		requestID: requestID,
		contact:   cfg.Contact,
	}
}

// Routes mounts the site endpoints under /api/v1.
func (h *Handler) Routes(r gin.IRouter, requireAuth, optionalAuth gin.HandlerFunc) {
	// Author archives are public on a public site, so the profile route takes optional
	// authentication and decides inside the handler using the resolved site's mode.
	r.GET("/users/:userID", optionalAuth, h.PublicUser)

	// The design document is what every visitor's browser needs in order to render the
	// site, so it is readable without a session. Writing it is site management and stays
	// behind the guard.
	r.GET("/sites/:siteID/customization", optionalAuth, h.GetCustomization)

	// The contact form is for readers, who by definition have no account: it is mounted
	// with the same optional authentication as the design document, and the handler
	// carries the anti-abuse layers (engine rate limit, honeypot, per-visitor cooldown).
	r.POST("/sites/:siteID/contact", optionalAuth, h.ContactMessage)

	group := r.Group("/sites", requireAuth)
	group.GET("/:siteID", h.GetSite)
	group.GET("/:siteID/members", h.ListMembers)
	group.PATCH("/:siteID/members/:userID", h.UpdateMember)
	group.PATCH("/:siteID/members/:userID/role", h.ChangeMemberRole)
	group.PATCH("/:siteID/members/:userID/status", h.UpdateMemberStatus)
	group.DELETE("/:siteID/members/:userID", h.DeleteMember)
	group.PUT("/:siteID/domain", h.UpdateDomain)
	group.PATCH("/:siteID/settings", h.UpdateSettings)
	group.PUT("/:siteID/customization", h.UpdateCustomization)
}

type memberResponse struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	Status      string `json:"status"`
	// Email is omitted when the account has no email login identity.
	Email string `json:"email,omitempty"`
}

// publicUserResponse is the author archive profile. It deliberately omits the email
// and membership status: those belong to administration, not to the public page.
type publicUserResponse struct {
	UserID      string    `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Role        string    `json:"role"`
	CreatedAt   time.Time `json:"created_at"`
}

type siteResponse struct {
	ID             string `json:"id"`
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	Domain         string `json:"domain"`
	VisibilityMode string `json:"visibility_mode"`
	PublishMode    string `json:"publish_mode"`
	Disabled       bool   `json:"disabled"`
}

type changeRoleRequest struct {
	Role string `json:"role"`
}

// updateMemberRequest is a partial profile update; omitted fields stay unchanged.
type updateMemberRequest struct {
	DisplayName *string `json:"display_name"`
	Email       *string `json:"email"`
}

type updateMemberStatusRequest struct {
	Status string `json:"status"`
}

type settingsRequest struct {
	Name           string `json:"name"`
	Description    string `json:"description"`
	VisibilityMode string `json:"visibility_mode"`
	PublishMode    string `json:"publish_mode"`
	Domain         string `json:"domain"`
}

// siteDomainRequest is a full domain replacement: the field is required so an empty
// body cannot silently clear the domain.
type siteDomainRequest struct {
	Domain *string `json:"domain"`
}

// GetSite returns the site to one of its members.
func (h *Handler) GetSite(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	found, err := h.service.Get(c.Request.Context(), actor.SiteID, actor.UserID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusOK, siteResponse{
		ID:             found.ID,
		Slug:           found.Slug,
		Name:           found.Name,
		Domain:         found.Domain,
		VisibilityMode: string(found.VisibilityMode),
		PublishMode:    string(found.PublishMode),
		Disabled:       found.Disabled,
	})
}

// ListMembers returns the members of a site to a manager.
func (h *Handler) ListMembers(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	members, err := h.service.ListMembers(c.Request.Context(), actor, actor.SiteID, 100)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	items := make([]memberResponse, 0, len(members))
	for _, member := range members {
		items = append(items, toMemberResponse(member))
	}

	c.JSON(http.StatusOK, gin.H{"items": items})
}

// PublicUser returns the author archive profile of one active member.
//
// The route is public on a public site and requires a session on a members-only one;
// the resolved site decides, so the client never has to know the mode. An account that
// is not an active member of the resolved site is not found, which keeps suspended and
// invited memberships out of the public directory.
func (h *Handler) PublicUser(c *gin.Context) {
	resolved, ok := h.site(c)
	if !ok {
		_ = c.Error(apperr.New(apperr.CodeSiteNotFound))
		return
	}

	// A session only satisfies the members-only gate when it belongs to *this* site.
	// Any valid token used to count as "authenticated" here, so a reader registered on
	// another tenant could read a closed directory; a suspended membership had the same
	// effect. Membership is now resolved against the host-resolved site.
	if userID, _, authenticated := h.principal(c); authenticated {
		if _, memberErr := h.service.Membership(c.Request.Context(), resolved.ID, userID); memberErr != nil {
			if !errors.Is(memberErr, ErrMemberNotFound) {
				_ = c.Error(mapError(memberErr))
				return
			}
			if resolved.IsMembersOnly() {
				_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "members_only_site"))
				return
			}
		}
	} else if resolved.IsMembersOnly() {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "members_only_site"))
		return
	}

	member, err := h.service.PublicMember(c.Request.Context(), resolved.ID, c.Param("userID"))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusOK, publicUserResponse{
		UserID:      member.UserID,
		DisplayName: member.DisplayName,
		Role:        string(member.Role),
		CreatedAt:   member.CreatedAt.UTC(),
	})
}

// UpdateMember edits the display name or login email of a lower member.
func (h *Handler) UpdateMember(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req updateMemberRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	member, err := h.service.UpdateMemberProfile(
		c.Request.Context(),
		actor,
		actor.SiteID,
		c.Param("userID"),
		MemberProfile{DisplayName: req.DisplayName, Email: req.Email},
		h.requestID(c),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusOK, toMemberResponse(member))
}

// UpdateMemberStatus suspends or reactivates a lower member.
func (h *Handler) UpdateMemberStatus(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req updateMemberStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	member, err := h.service.UpdateMemberStatus(
		c.Request.Context(),
		actor,
		actor.SiteID,
		c.Param("userID"),
		req.Status,
		h.requestID(c),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusOK, toMemberResponse(member))
}

// DeleteMember removes a lower member from the site.
func (h *Handler) DeleteMember(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	if err := h.service.DeleteMember(
		c.Request.Context(),
		actor,
		actor.SiteID,
		c.Param("userID"),
		h.requestID(c),
	); err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.Status(http.StatusNoContent)
}

// ChangeMemberRole changes another member's role.
func (h *Handler) ChangeMemberRole(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req changeRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	err := h.service.ChangeMemberRole(
		c.Request.Context(),
		actor,
		actor.SiteID,
		c.Param("userID"),
		Role(req.Role),
		h.requestID(c),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.Status(http.StatusNoContent)
}

// UpdateSettings changes site level configuration.
func (h *Handler) UpdateSettings(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req settingsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	err := h.service.UpdateSettings(c.Request.Context(), actor, actor.SiteID, SettingsInput{
		Name:           req.Name,
		Description:    req.Description,
		VisibilityMode: VisibilityMode(req.VisibilityMode),
		PublishMode:    PublishMode(req.PublishMode),
		Domain:         req.Domain,
	}, h.requestID(c))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.Status(http.StatusNoContent)
}

// UpdateDomain sets or clears the site's primary domain.
//
// A non-empty value is stored with domain_verified_at, so the site becomes reachable
// on it immediately; an empty string clears both and restores the domain-less
// fallback. Validation rejects anything that is not a bare hostname.
func (h *Handler) UpdateDomain(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req siteDomainRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	if req.Domain == nil {
		_ = c.Error(apperr.Validation("domain is required; send an empty string to clear it"))
		return
	}

	if err := h.service.UpdateDomain(
		c.Request.Context(),
		actor,
		actor.SiteID,
		*req.Domain,
		h.requestID(c),
	); err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.Status(http.StatusNoContent)
}

// customizationResponse is the design document a browser renders the site from.
type customizationResponse struct {
	SiteID        string          `json:"site_id"`
	Revision      int             `json:"revision"`
	UpdatedAt     time.Time       `json:"updated_at"`
	Customization json.RawMessage `json:"customization"`
}

// customizationSavedResponse is what a successful write returns.
type customizationSavedResponse struct {
	Revision  int       `json:"revision"`
	UpdatedAt time.Time `json:"updated_at"`
}

// customizationRequest is a design document write.
//
// Customization is kept as raw JSON so the bytes stored are the bytes the browser sent:
// re-encoding through a map would reorder keys and silently drop duplicate keys the
// frontend may rely on when it round-trips its own export format.
type customizationRequest struct {
	Customization json.RawMessage `json:"customization"`
	// Revision is the revision the client last read. Omitted means "no precondition",
	// which is what a first save from a fresh install sends.
	Revision *int `json:"revision,omitempty"`
}

// customizationETag derives a strong ETag from the revision and the document bytes.
//
// The document is the whole design: theme, pages, blocks, custom CSS. Visitors fetch it
// on every page load, so a 304 is worth far more than caching a few hundred kilobytes.
func customizationETag(revision int, document []byte) string {
	sum := sha256.Sum256(document)
	fingerprint := hex.EncodeToString(sum[:16])
	return fmt.Sprintf("\"%d-%s\"", revision, fingerprint)
}

// ifNoneMatchHit reports whether the request already holds that ETag.
func ifNoneMatchHit(header, etag string) bool {
	header = strings.TrimSpace(header)
	if header == "" {
		return false
	}
	if header == "*" {
		return true
	}
	for _, candidate := range strings.Split(header, ",") {
		if strings.TrimSpace(candidate) == etag {
			return true
		}
	}
	return false
}

// GetCustomization returns the saved design document of the site.
//
// Visibility is decided here rather than by requiring a session. On a members-only site
// the design names the private pages, so an outsider gets the same 404 a site that never
// saved one returns: no leak, and no 401 noise on a request every visitor makes during
// boot (a 401 there would look like an expired session to the browser).
func (h *Handler) GetCustomization(c *gin.Context) {
	siteID := c.Param("siteID")

	resolved, ok := h.site(c)
	if !ok {
		_ = c.Error(apperr.New(apperr.CodeSiteNotFound).WithRequestID(h.requestID(c)))
		return
	}
	if resolved.ID != siteID {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "cross_site"))
		return
	}
	if resolved.IsMembersOnly() && !h.isMemberOf(c, resolved.ID) {
		_ = c.Error(apperr.NotFound("customization"))
		return
	}

	customization, err := h.service.Customization(c.Request.Context(), siteID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	// The ETag comes after the visibility checks above, never before: a 304 is still a
	// hint that the resource exists, so it must not answer a caller the 404 hides it from.
	etag := customizationETag(customization.Revision, customization.Document)
	c.Header("Cache-Control", "no-cache")
	c.Header("ETag", etag)
	if ifNoneMatchHit(c.GetHeader("If-None-Match"), etag) {
		// A 304 carries no body: the design document can be hundreds of KB, and a
		// returning visitor should not download it again.
		c.Status(http.StatusNotModified)
		return
	}

	c.JSON(http.StatusOK, customizationResponse{
		SiteID:        siteID,
		Revision:      customization.Revision,
		UpdatedAt:     customization.UpdatedAt,
		Customization: json.RawMessage(customization.Document),
	})
}

// UpdateCustomization stores the design document of the site.
func (h *Handler) UpdateCustomization(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	// Bound the body before decoding: the service rejects an oversized document, but by
	// then the request has already been read into memory.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, MaxCustomizationBytes+4096)

	var req customizationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	expectedRevision := 0
	if req.Revision != nil {
		expectedRevision = *req.Revision
	}

	saved, err := h.service.SaveCustomization(
		c.Request.Context(),
		actor,
		actor.SiteID,
		[]byte(req.Customization),
		expectedRevision,
		h.requestID(c),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusOK, customizationSavedResponse{
		Revision:  saved.Revision,
		UpdatedAt: saved.UpdatedAt,
	})
}

// isMemberOf reports whether the caller holds an active membership of siteID.
//
// It is used only to decide whether a design document may be read; a failure of any kind
// answers "no", which is the safe direction for a document that names private pages.
func (h *Handler) isMemberOf(c *gin.Context, siteID string) bool {
	userID, tokenSiteID, ok := h.principal(c)
	if !ok || userID == "" {
		return false
	}
	if tokenSiteID != "" && tokenSiteID != siteID {
		return false
	}
	if _, err := h.service.Membership(c.Request.Context(), siteID, userID); err != nil {
		return false
	}
	return true
}

// actor loads the caller's membership of the site in the path.
//
// The path site and the token site must agree: a site administrator of site A must
// not reach site B by editing the URL, even when the same account belongs to both.
// The membership lookup then enforces the role and that the membership is active.
func (h *Handler) actor(c *gin.Context, siteID string) (Member, bool) {
	userID, tokenSiteID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return Member{}, false
	}
	if tokenSiteID != "" && tokenSiteID != siteID {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "cross_site"))
		return Member{}, false
	}

	member, err := h.service.Membership(c.Request.Context(), siteID, userID)
	if err != nil {
		_ = c.Error(mapError(err))
		return Member{}, false
	}
	return member, true
}

// toMemberResponse renders a membership for the admin screens.
func toMemberResponse(member Member) memberResponse {
	return memberResponse{
		UserID:      member.UserID,
		DisplayName: member.DisplayName,
		Role:        string(member.Role),
		Status:      member.Status,
		Email:       member.Email,
	}
}

// mapError translates site failures into the API error model.
func mapError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil

	case errors.Is(err, ErrMemberNotFound):
		return apperr.PermissionDenied().WithDetail("reason", "not_a_member")

	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")

	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()

	case errors.Is(err, ErrCannotManageSelf):
		return apperr.PermissionDenied().WithDetail("reason", "self_management")

	case errors.Is(err, ErrTargetTooPrivileged):
		return apperr.PermissionDenied().WithDetail("reason", "target_role_not_lower")

	case errors.Is(err, ErrLastPlatformAdmin):
		return apperr.PermissionDenied().WithDetail("reason", "last_platform_admin")

	case errors.Is(err, ErrTargetNotFound):
		return apperr.NotFound("member")

	case errors.Is(err, ErrEmailTaken):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "email_taken").
			WithMessage("该邮箱已经被其他账户使用")

	case errors.Is(err, ErrDomainTaken):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "domain_taken").
			WithMessage("该域名已经被其他站点使用")

	case errors.Is(err, ErrCustomizationConflict):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "revision_conflict").
			WithMessage("站点设计已在别处被修改，请先刷新再保存")

	case errors.Is(err, ErrCustomizationTooLarge):
		return apperr.Validation("customization document is too large")

	case errors.Is(err, ErrCustomizationNotFound):
		return apperr.NotFound("customization")

	case errors.Is(err, ErrInvalidRole):
		return apperr.Validation("unknown role")

	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation(cleanValidation(err))

	case errors.Is(err, ErrDomainUnverified):
		return apperr.New(apperr.CodeSiteDomainUnverified)

	case errors.Is(err, ErrDisabled), errors.Is(err, ErrNotFound):
		return apperr.NotFound("site")
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}

// cleanValidation keeps validator wording short and free of internal type names.
//
// The domain package prefixes its validation errors with the sentinel text, which is
// useful in logs but noise in an API message; strip it so the client reads the reason.
func cleanValidation(err error) string {
	message := strings.TrimPrefix(err.Error(), "site: invalid input: ")
	message = strings.TrimPrefix(message, "site: invalid input")
	message = strings.TrimSpace(message)
	if message == "" {
		return "invalid input"
	}
	if len(message) > 200 {
		return "invalid input"
	}
	return message
}
