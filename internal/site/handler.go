package site

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/platform/page"
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
//
// protected carries the extra middleware the transport wants on the guarded
// routes, notably the step-up guard that re-authenticates high threat operations.
func (h *Handler) Routes(r gin.IRouter, requireAuth, optionalAuth gin.HandlerFunc, protected ...gin.HandlerFunc) {
	// Author archives are public on a public site, so the profile route takes optional
	// authentication and decides inside the handler using the resolved site's mode.
	r.GET("/users/:userID", optionalAuth, h.PublicUser)

	// The member directory is a community feature, not an administration one: it
	// requires a session but returns only the public profile projection.
	r.GET("/members", requireAuth, h.Directory)

	// The design document is what every visitor's browser needs in order to render the
	// site, so it is readable without a session. Writing it is site management and stays
	// behind the guard.
	r.GET("/sites/:siteID/customization", optionalAuth, h.GetCustomization)

	// The site configuration carries the access rules, loading screen and admin entry a
	// visitor's browser executes, so the read is public too. The response is projected:
	// an administrator sees the whole document, everyone else the anonymous subset.
	r.GET("/sites/:siteID/site-config", optionalAuth, h.GetSiteConfig)

	// The contact form is for readers, who by definition have no account: it is mounted
	// with the same optional authentication as the design document, and the handler
	// carries the anti-abuse layers (engine rate limit, honeypot, per-visitor cooldown).
	r.POST("/sites/:siteID/contact", optionalAuth, h.ContactMessage)

	guards := append([]gin.HandlerFunc{requireAuth}, protected...)
	group := r.Group("/sites", guards...)
	group.GET("/:siteID", h.GetSite)
	group.GET("/:siteID/members", h.ListMembers)
	group.PATCH("/:siteID/members/:userID", h.UpdateMember)
	group.PATCH("/:siteID/members/:userID/role", h.ChangeMemberRole)
	group.PATCH("/:siteID/members/:userID/group", h.ChangeMemberGroup)
	group.PATCH("/:siteID/members/:userID/status", h.UpdateMemberStatus)
	group.PATCH("/:siteID/members/:userID/quota", h.UpdateMemberMediaQuota)
	group.DELETE("/:siteID/members/:userID", h.DeleteMember)
	group.GET("/:siteID/permission-groups", h.ListPermissionGroups)
	group.PUT("/:siteID/permission-groups/:groupKey", h.SavePermissionGroup)
	group.PUT("/:siteID/domain", h.UpdateDomain)
	group.GET("/:siteID/domain", h.GetDomain)
	group.POST("/:siteID/domain/verify", h.VerifyDomain)
	group.PATCH("/:siteID/settings", h.UpdateSettings)
	group.PUT("/:siteID/customization", h.UpdateCustomization)
	group.PUT("/:siteID/site-config", h.UpdateSiteConfig)
	group.GET("/:siteID/step-up", h.GetStepUp)
	group.PUT("/:siteID/step-up", h.UpdateStepUp)
}

type memberResponse struct {
	UserID          string `json:"user_id"`
	DisplayName     string `json:"display_name"`
	Role            string `json:"role"`
	Status          string `json:"status"`
	MediaQuotaBytes *int64 `json:"media_quota_bytes"`
	// GroupKey and GroupName expose the capability group the member belongs to.
	// They are always present: an unassigned member reports the built-in group of
	// its role, and GroupName is empty when the operator never renamed it.
	GroupKey  string `json:"group_key"`
	GroupName string `json:"group_name"`
	// Email is omitted when the account has no email login identity.
	Email string `json:"email,omitempty"`
}

// publicUserResponse is the author archive profile. It deliberately omits the email
// and membership status: those belong to administration, not to the public page.
type publicUserResponse struct {
	UserID        string    `json:"user_id"`
	DisplayName   string    `json:"display_name"`
	Bio           string    `json:"bio,omitempty"`
	AvatarMediaID string    `json:"avatar_media_id,omitempty"`
	Role          string    `json:"role"`
	CreatedAt     time.Time `json:"created_at"`
}

type siteResponse struct {
	ID                    string `json:"id"`
	Slug                  string `json:"slug"`
	Name                  string `json:"name"`
	Domain                string `json:"domain"`
	DomainVerified        bool   `json:"domain_verified"`
	RegistrationOpen      bool   `json:"registration_open"`
	CommentsEnabled       bool   `json:"comments_enabled"`
	CommentsRequireReview bool   `json:"comments_require_review"`
	MediaQuotaBytes       *int64 `json:"media_quota_bytes"`
	VisibilityMode        string `json:"visibility_mode"`
	PublishMode           string `json:"publish_mode"`
	Disabled              bool   `json:"disabled"`
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
	Name                  string          `json:"name"`
	Description           string          `json:"description"`
	VisibilityMode        string          `json:"visibility_mode"`
	PublishMode           string          `json:"publish_mode"`
	Domain                string          `json:"domain"`
	RegistrationOpen      *bool           `json:"registration_open"`
	CommentsEnabled       *bool           `json:"comments_enabled"`
	CommentsRequireReview *bool           `json:"comments_require_review"`
	MediaQuotaBytes       json.RawMessage `json:"media_quota_bytes"`
}

type memberQuotaRequest struct {
	MediaQuotaBytes json.RawMessage `json:"media_quota_bytes"`
}

// siteDomainRequest is a full domain replacement: the field is required so an empty
// body cannot silently clear the domain.
type siteDomainRequest struct {
	Domain *string `json:"domain"`
}

// domainResponse is the domain screen payload.
//
// While the domain is pending, verification_token and record_name tell the operator
// exactly which DNS TXT record to publish; once verified the token is omitted. With no
// domain all four fields are empty.
type domainResponse struct {
	Domain            string `json:"domain"`
	Verified          bool   `json:"verified"`
	VerificationToken string `json:"verification_token"`
	RecordName        string `json:"record_name"`
	RecordType        string `json:"record_type"`
}

func toDomainResponse(status DomainStatus) domainResponse {
	return domainResponse{
		Domain:            status.Domain,
		Verified:          status.Verified,
		VerificationToken: status.VerificationToken,
		RecordName:        status.RecordName,
		RecordType:        status.RecordType,
	}
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
		ID:                    found.ID,
		Slug:                  found.Slug,
		Name:                  found.Name,
		Domain:                found.Domain,
		DomainVerified:        found.DomainVerified(),
		RegistrationOpen:      found.RegistrationOpen,
		CommentsEnabled:       found.CommentsEnabled,
		CommentsRequireReview: found.CommentsRequireReview,
		MediaQuotaBytes:       found.MediaQuotaBytes,
		VisibilityMode:        string(found.VisibilityMode),
		PublishMode:           string(found.PublishMode),
		Disabled:              found.Disabled,
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
		UserID:        member.UserID,
		DisplayName:   member.DisplayName,
		Bio:           member.Bio,
		AvatarMediaID: member.AvatarMediaID,
		Role:          string(member.Role),
		CreatedAt:     member.CreatedAt.UTC(),
	})
}

// Directory lists active members of the caller's site to any signed-in member.
//
// The response is the public profile projection; the admin member list keeps its
// own route under /sites/{siteID}/members because it carries email and status.
func (h *Handler) Directory(c *gin.Context) {
	userID, siteID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	cursor, err := page.Decode(c.Query("cursor"))
	if err != nil {
		_ = c.Error(apperr.New(apperr.CodeInvalidCursor))
		return
	}
	limit, _ := strconv.Atoi(c.Query("limit"))

	members, next, err := h.service.MemberDirectory(
		c.Request.Context(), siteID, userID, c.Query("q"), limit, cursor,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	items := make([]publicUserResponse, 0, len(members))
	for _, member := range members {
		items = append(items, publicUserResponse{
			UserID:        member.UserID,
			DisplayName:   member.DisplayName,
			Bio:           member.Bio,
			AvatarMediaID: member.AvatarMediaID,
			Role:          string(member.Role),
			CreatedAt:     member.CreatedAt.UTC(),
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"items":       items,
		"next_cursor": next.Encode(),
		"has_more":    !next.IsZero(),
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

// UpdateMemberMediaQuota changes or clears one member's explicit storage override.
func (h *Handler) UpdateMemberMediaQuota(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req memberQuotaRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	quota, err := parseQuotaOverride(req.MediaQuotaBytes)
	if err != nil {
		_ = c.Error(apperr.Validation("media_quota_bytes must be a non-negative integer or null"))
		return
	}

	member, err := h.service.UpdateMemberMediaQuota(c.Request.Context(), actor, actor.SiteID,
		c.Param("userID"), quota, h.requestID(c))
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

// permissionGroupResponse is one capability group.
type permissionGroupResponse struct {
	Key          string          `json:"key"`
	Name         string          `json:"name"`
	BaseRole     string          `json:"base_role"`
	Capabilities map[string]bool `json:"capabilities"`
	AdminAccess  bool            `json:"admin_access"`
	Builtin      bool            `json:"builtin"`
}

// permissionGroupRequest is a full replacement of one group.
//
// Capabilities is the expanded matrix, not a delta: the dashboard always sends the
// whole row it renders, so a missed capability is an explicit "off".
type permissionGroupRequest struct {
	Name         string          `json:"name"`
	BaseRole     string          `json:"base_role"`
	Capabilities map[string]bool `json:"capabilities"`
	AdminAccess  bool            `json:"admin_access"`
}

type changeGroupRequest struct {
	GroupKey string `json:"group_key"`
}

// ListPermissionGroups returns the capability groups of the caller's site.
func (h *Handler) ListPermissionGroups(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	groups, err := h.service.ListPermissionGroups(c.Request.Context(), actor, actor.SiteID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	items := make([]permissionGroupResponse, 0, len(groups))
	for _, group := range groups {
		items = append(items, toPermissionGroupResponse(group))
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// SavePermissionGroup creates or updates one group.
func (h *Handler) SavePermissionGroup(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req permissionGroupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	capabilities := make([]Capability, 0, len(req.Capabilities))
	for raw, enabled := range req.Capabilities {
		if enabled {
			capabilities = append(capabilities, Capability(raw))
		}
	}

	group, err := h.service.SavePermissionGroup(
		c.Request.Context(),
		actor,
		actor.SiteID,
		c.Param("groupKey"),
		PermissionGroupInput{
			Name:         req.Name,
			BaseRole:     Role(req.BaseRole),
			Capabilities: capabilities,
			AdminAccess:  req.AdminAccess,
		},
		h.requestID(c),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toPermissionGroupResponse(group))
}

// ChangeMemberGroup moves a member into a capability group.
func (h *Handler) ChangeMemberGroup(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req changeGroupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	if err := h.service.AssignMemberGroup(
		c.Request.Context(),
		actor,
		actor.SiteID,
		c.Param("userID"),
		req.GroupKey,
		h.requestID(c),
	); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Status(http.StatusNoContent)
}

// toPermissionGroupResponse renders a group for the dashboard.
func toPermissionGroupResponse(group PermissionGroup) permissionGroupResponse {
	capabilities := make(map[string]bool, len(AllCapabilities))
	for _, capability := range AllCapabilities {
		capabilities[string(capability)] = group.Capabilities.Allows(capability)
	}
	return permissionGroupResponse{
		Key:          group.Key,
		Name:         group.Name,
		BaseRole:     string(group.BaseRole),
		Capabilities: capabilities,
		AdminAccess:  group.AdminAccess,
		Builtin:      group.Builtin,
	}
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
	quota, err := parseQuotaOverride(req.MediaQuotaBytes)
	if err != nil {
		_ = c.Error(apperr.Validation("media_quota_bytes must be a non-negative integer or null"))
		return
	}

	err = h.service.UpdateSettings(c.Request.Context(), actor, actor.SiteID, SettingsInput{
		Name:                  req.Name,
		Description:           req.Description,
		VisibilityMode:        VisibilityMode(req.VisibilityMode),
		PublishMode:           PublishMode(req.PublishMode),
		Domain:                req.Domain,
		RegistrationOpen:      req.RegistrationOpen,
		CommentsEnabled:       req.CommentsEnabled,
		CommentsRequireReview: req.CommentsRequireReview,
		MediaQuota:            quota,
	}, h.requestID(c))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.Status(http.StatusNoContent)
}

func parseQuotaOverride(raw json.RawMessage) (QuotaOverride, error) {
	if raw == nil {
		return QuotaOverride{}, nil
	}
	var value *int64
	if err := json.Unmarshal(raw, &value); err != nil {
		return QuotaOverride{}, ErrInvalidInput
	}
	if value != nil && *value < 0 {
		return QuotaOverride{}, ErrInvalidInput
	}
	return QuotaOverride{Present: true, Bytes: value}, nil
}

// UpdateDomain declares or clears the site's primary domain.
//
// A non-empty value only starts a DNS ownership challenge: it is stored unverified
// together with a fresh TXT token, and serving on it begins after
// POST /sites/{id}/domain/verify succeeds. An empty string clears the domain, the
// challenge and the verification, restoring the domain-less fallback.
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

// GetDomain returns the domain screen state of the site.
func (h *Handler) GetDomain(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	status, err := h.service.DomainStatus(c.Request.Context(), actor, actor.SiteID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toDomainResponse(status))
}

// VerifyDomain runs the DNS TXT challenge and reports the new state.
//
// A mismatch or DNS failure answers 409 with reason domain_verification_failed; the
// client is expected to fix the record and retry.
func (h *Handler) VerifyDomain(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	status, err := h.service.VerifyDomain(c.Request.Context(), actor, actor.SiteID, h.requestID(c))
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toDomainResponse(status))
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

// siteConfigResponse is the site configuration a browser boots from.
//
// Scope tells the client which projection it received: an administrator gets the full
// document (including TLS paths and OAuth client ids), everyone else the anonymous
// subset. The client uses it to decide whether a hydration may overwrite local admin
// settings.
type siteConfigResponse struct {
	SiteID    string          `json:"site_id"`
	Revision  int             `json:"revision"`
	UpdatedAt time.Time       `json:"updated_at"`
	Scope     string          `json:"scope"`
	Config    json.RawMessage `json:"config"`
}

// siteConfigSavedResponse is what a successful write returns.
type siteConfigSavedResponse struct {
	Revision  int       `json:"revision"`
	UpdatedAt time.Time `json:"updated_at"`
}

// siteConfigRequest is a configuration write.
//
// Config is raw JSON for the same reason the design document is: the bytes the browser
// sent are the bytes stored, and the service validates fields without re-encoding the
// payload.
type siteConfigRequest struct {
	Config json.RawMessage `json:"config"`
	// Revision is the revision the client last read. Omitted means "no precondition",
	// which is what a first save from a fresh install sends.
	Revision *int `json:"revision,omitempty"`
}

// siteConfigETags are the audience names used in the strong ETag.
const (
	siteConfigScopeAdmin  = "admin"
	siteConfigScopePublic = "public"
)

// siteConfigETag derives a strong ETag from the audience, the revision and the emitted
// bytes. The audience is part of it so an administrator's cached full document can never
// validate an anonymous response, or the other way around.
func siteConfigETag(scope string, revision int, payload []byte) string {
	sum := sha256.Sum256(payload)
	fingerprint := hex.EncodeToString(sum[:16])
	return fmt.Sprintf("\"%s-%d-%s\"", scope, revision, fingerprint)
}

// GetSiteConfig returns the saved site configuration of the site.
//
// Visibility follows GetCustomization: a members-only site answers 404 to an outsider, so
// the boot request every visitor makes never turns into 401 noise. An authenticated
// manager additionally gets the full document; anyone else gets the public projection.
func (h *Handler) GetSiteConfig(c *gin.Context) {
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
		_ = c.Error(apperr.NotFound("site-config"))
		return
	}

	stored, err := h.service.SiteConfig(c.Request.Context(), siteID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	var (
		scope   = siteConfigScopePublic
		payload json.RawMessage
	)
	if h.canManageSite(c, resolved.ID) {
		scope = siteConfigScopeAdmin
		// The administrator sees the whole document, except the step-up secret: the
		// dedicated security password hash never leaves the server, not even to an
		// administrator's own browser.
		payload, err = SanitizeSiteConfigForAdmin(stored.Document)
		if err != nil {
			_ = c.Error(apperr.Internal(err))
			return
		}
	} else {
		payload, err = PublicSiteConfig(stored.Document)
		if err != nil {
			_ = c.Error(apperr.Internal(err))
			return
		}
	}

	// The ETag comes after the visibility checks, never before: a 304 is still a hint
	// that the resource exists, so it must not answer a caller the 404 hides it from.
	etag := siteConfigETag(scope, stored.Revision, payload)
	// private: the body differs by audience, so a shared cache must not reuse it.
	c.Header("Cache-Control", "private, no-cache")
	c.Header("Vary", "Authorization")
	c.Header("ETag", etag)
	if ifNoneMatchHit(c.GetHeader("If-None-Match"), etag) {
		c.Status(http.StatusNotModified)
		return
	}

	c.JSON(http.StatusOK, siteConfigResponse{
		SiteID:    siteID,
		Revision:  stored.Revision,
		UpdatedAt: stored.UpdatedAt,
		Scope:     scope,
		Config:    json.RawMessage(payload),
	})
}

// UpdateSiteConfig stores the site configuration of the site.
func (h *Handler) UpdateSiteConfig(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	// Bound the body before decoding: the service rejects an oversized document, but by
	// then the request has already been read into memory.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, MaxSiteConfigBytes+4096)

	var req siteConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	expectedRevision := 0
	if req.Revision != nil {
		expectedRevision = *req.Revision
	}

	saved, err := h.service.SaveSiteConfig(
		c.Request.Context(),
		actor,
		actor.SiteID,
		[]byte(req.Config),
		expectedRevision,
		h.requestID(c),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusOK, siteConfigSavedResponse{
		Revision:  saved.Revision,
		UpdatedAt: saved.UpdatedAt,
	})
}

// canManageSite reports whether the caller may administer siteID.
//
// It only decides whether the response carries the full document; a failure of any kind
// answers "no", so an unexpected error degrades to the public projection instead of
// leaking the administrator-only fields.
func (h *Handler) canManageSite(c *gin.Context, siteID string) bool {
	userID, tokenSiteID, ok := h.principal(c)
	if !ok || userID == "" {
		return false
	}
	if tokenSiteID != "" && tokenSiteID != siteID {
		return false
	}
	member, err := h.service.Membership(c.Request.Context(), siteID, userID)
	if err != nil {
		return false
	}
	return Can(member, ActionManageSite)
}

// isMemberOf reports whether the caller holds an active membership of siteID.//
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
		UserID:          member.UserID,
		DisplayName:     member.DisplayName,
		Role:            string(member.Role),
		Status:          member.Status,
		Email:           member.Email,
		MediaQuotaBytes: member.MediaQuotaBytes,
		GroupKey:        member.GroupKey,
		GroupName:       member.GroupName,
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

	case errors.Is(err, ErrPlatformAdminLocked):
		// The highest administrator group is reserved for the account that
		// registered the site: it cannot be granted or revoked from user management.
		return apperr.PermissionDenied().
			WithDetail("reason", "platform_admin_locked").
			WithMessage("最高管理员是注册该账号的人，不能在用户管理中更改用户组")

	case errors.Is(err, ErrTargetNotFound):
		return apperr.NotFound("member")

	case errors.Is(err, ErrPermissionGroupNotFound):
		return apperr.NotFound("permission group")

	case errors.Is(err, ErrPermissionGroupReadOnly):
		return apperr.PermissionDenied().WithDetail("reason", "permission_group_readonly")

	case errors.Is(err, ErrEmailTaken):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "email_taken").
			WithMessage("该邮箱已经被其他账户使用")

	case errors.Is(err, ErrDomainTaken):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "domain_taken").
			WithMessage("该域名已经被其他站点使用")

	case errors.Is(err, ErrDomainVerificationFailed):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "domain_verification_failed").
			WithMessage("域名所有权验证未通过，请检查 DNS TXT 记录后重试")

	case errors.Is(err, ErrCustomizationConflict):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "revision_conflict").
			WithMessage("站点设计已在别处被修改，请先刷新再保存")

	case errors.Is(err, ErrCustomizationTooLarge):
		return apperr.Validation("customization document is too large")

	case errors.Is(err, ErrCustomizationNotFound):
		return apperr.NotFound("customization")

	case errors.Is(err, ErrSiteConfigConflict):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "config_revision_conflict").
			WithMessage("站点配置已在别处被修改，请先刷新再保存")

	case errors.Is(err, ErrSiteConfigTooLarge):
		return apperr.Validation("site config document is too large")

	case errors.Is(err, ErrSiteConfigNotFound):
		return apperr.NotFound("site-config")

	case errors.Is(err, ErrStepUpRequired):
		// The high threat action needs a fresh password proof; the client opens its
		// step-up dialog and retries with X-PP-Step-Up.
		return apperr.PermissionDenied().WithDetail("reason", "step_up_required")

	case errors.Is(err, ErrStepUpUnavailable):
		// Wiring error: fail closed instead of letting the action through.
		return apperr.Internal(err)

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
