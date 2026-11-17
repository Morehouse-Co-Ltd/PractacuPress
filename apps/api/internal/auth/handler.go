package auth

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/captcha"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Browser session cookie and header names.
const (
	// RefreshCookieName holds the rotating opaque refresh token.
	RefreshCookieName = "pp_refresh"
	// CSRFCookieName holds the double submit token. It is readable by JavaScript
	// on purpose, so the client can echo it in CSRFCookieHeader.
	CSRFCookieName = "pp_csrf"
	// CSRFHeaderName is the header the client must echo the CSRF cookie in.
	CSRFHeaderName = "X-CSRF-Token"
	// RefreshCookiePath scopes the refresh cookie to the auth endpoints only, so it
	// is not attached to ordinary API calls.
	RefreshCookiePath = "/api/v1/auth"
)

// SiteIDFunc resolves the site a request belongs to. It is injected so this
// package does not depend on the HTTP middleware.
type SiteIDFunc func(*gin.Context) string

// PrincipalFunc returns the authenticated caller, if any.
type PrincipalFunc func(*gin.Context) (Principal, bool)

// CaptchaGuard enforces the site's human verification policy.
//
// The interface keeps this package unaware of provider details and HTTP clients;
// the composition root wires a captcha.Guard. A nil guard means "no challenge",
// which is what the package's unit tests and a deployment without secrets use.
type CaptchaGuard interface {
	Require(ctx context.Context, in captcha.RequireInput) error
}

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	// SecureCookies marks cookies Secure. It must be true in production.
	SecureCookies bool
	// CookieDomain optionally scopes cookies to a parent domain.
	CookieDomain string
	// SiteID resolves the current site. Required.
	SiteID SiteIDFunc
	// Principal resolves the authenticated caller. Required for GET /me.
	Principal PrincipalFunc
	// CredentialLimiter, when set, is charged once per request in front of the
	// endpoints that consume a password: registration, login and both halves of
	// password reset.
	//
	// The process wide limiter is sized for ordinary browsing; these endpoints are the
	// ones worth brute forcing, and every accepted attempt costs an Argon2 hash (64 MiB
	// of memory in the security service). A separate, far tighter budget keeps a
	// credential stuffing run from saturating the hashing path.
	CredentialLimiter gin.HandlerFunc
	// FirstAdminAllowed decides whether this request may create the install's first
	// account (which the bootstrap promotes to platform administrator). Nil means "no
	// request may": a deployment that enables BootstrapFirstAdmin must wire this,
	// normally to AllowFirstAdminFromLoopback, or its setup wizard can never create an
	// administrator.
	FirstAdminAllowed FirstAdminFunc
	// Captcha enforces the site's human verification policy on the credential
	// entry points. Nil disables the check; the settings page reports that state.
	Captcha CaptchaGuard
	// RequestID returns the request correlation id, recorded in the captcha audit
	// row so an operator can tie a refusal to the HTTP log.
	RequestID func(*gin.Context) string
	// GroupKey resolves the caller's capability group on the current site. It is
	// optional: a deployment without permission groups leaves /me without a
	// group_key and the client falls back to the four fixed roles.
	GroupKey func(ctx context.Context, siteID, userID string) (string, error)
}

// Handler exposes the authentication use cases over HTTP.
type Handler struct {
	service    *Service
	secure     bool
	domain     string
	siteID     SiteIDFunc
	principal  PrincipalFunc
	credential gin.HandlerFunc
	firstAdmin FirstAdminFunc
	captcha    CaptchaGuard
	requestID  func(*gin.Context) string
	groupKey   func(ctx context.Context, siteID, userID string) (string, error)
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	siteID := cfg.SiteID
	if siteID == nil {
		siteID = func(*gin.Context) string { return "" }
	}
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (Principal, bool) { return Principal{}, false }
	}
	credential := cfg.CredentialLimiter
	if credential == nil {
		credential = func(c *gin.Context) { c.Next() }
	}
	requestID := cfg.RequestID
	if requestID == nil {
		requestID = func(c *gin.Context) string { return c.GetHeader("X-Request-ID") }
	}
	return &Handler{
		service:    service,
		secure:     cfg.SecureCookies,
		domain:     cfg.CookieDomain,
		siteID:     siteID,
		principal:  principal,
		credential: credential,
		firstAdmin: cfg.FirstAdminAllowed,
		captcha:    cfg.Captcha,
		requestID:  requestID,
		groupKey:   cfg.GroupKey,
	}
}

// Routes mounts the authentication endpoints under /api/v1.
//
// requireAuth guards only GET /me: registration, login and refresh must work without
// an access token, and logout must work with an expired one. protected carries the
// extra middleware the transport wants on guarded routes, notably the step-up guard
// that re-authenticates the high threat member operations mounted here.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc, protected ...gin.HandlerFunc) {
	guards := append([]gin.HandlerFunc{requireAuth}, protected...)
	// withAuth prepends the guarded chain to one route's own handlers.
	withAuth := func(handlers ...gin.HandlerFunc) []gin.HandlerFunc {
		return append(append([]gin.HandlerFunc{}, guards...), handlers...)
	}

	group := r.Group("/auth")
	// The credential limiter runs first (it is the cheapest rejection and the first
	// brute force tier); the write guard then enforces same-origin plus JSON before any
	// body is parsed or cookie is written.
	group.POST("/register/email", h.credential, h.guard(true), h.RegisterEmail)
	group.POST("/login/password", h.credential, h.guard(true), h.LoginPassword)
	group.POST("/token/refresh", h.guard(false), h.Refresh)
	group.POST("/logout", h.guard(false), h.Logout)
	// Password reset must work for a caller who cannot log in at all, so the whole
	// flow sits next to registration rather than behind requireAuth.
	group.GET("/password-reset/policy", h.PasswordResetPolicy)
	group.POST("/password-reset/request", h.credential, h.guard(true), h.RequestPasswordReset)
	group.POST("/password-reset/confirm", h.credential, h.guard(true), h.ResetPassword)

	// Email verification is public: the link is clicked from a mail client that has
	// no session, and the token is the only credential it needs. The write guard
	// still enforces same-origin JSON, so a cross-site form cannot burn a token.
	group.POST("/email/verify", h.guard(true), h.VerifyEmail)
	// Password change lives under /auth on purpose: the refresh cookie is scoped to
	// that path, and the handler needs it to keep the caller's own session while
	// revoking the others.
	group.POST("/password/change", withAuth(h.credential, h.guard(true), h.ChangePassword)...)
	// High threat operations re-prove the password here. The endpoint consumes a
	// password, so it sits behind the same credential limiter as login, and its
	// failure (403 reason step_up_password_rejected) is throttled the same way.
	group.POST("/step-up", withAuth(h.credential, h.guard(true), h.VerifyStepUp)...)
	// FSD F-04 second step: a 2FA protected password login returns a challenge
	// instead of a session, and this endpoint redeems it. It must work without an
	// access token, and it consumes a code, so it sits behind the credential limiter.
	group.POST("/login/2fa", h.credential, h.guard(true), h.LoginTwoFactor)

	r.GET("/me", withAuth(h.Me)...)
	// Self-service two-factor management. The whole surface sits under /me because
	// every operation acts on the caller's own account.
	r.GET("/me/2fa", withAuth(h.TwoFactorStatus)...)
	r.POST("/me/2fa/enroll", withAuth(h.credential, h.guard(true), h.BeginTwoFactorEnrollment)...)
	r.POST("/me/2fa/confirm", withAuth(h.credential, h.guard(true), h.ConfirmTwoFactor)...)
	r.POST("/me/2fa/disable", withAuth(h.credential, h.guard(true), h.DisableTwoFactor)...)
	r.POST("/me/2fa/recovery-codes", withAuth(h.credential, h.guard(true), h.RegenerateTwoFactorRecoveryCodes)...)
	// Administrator reset for a lost device. It lives with the member routes it acts
	// on, and the service enforces the platform administrator role itself.
	r.POST("/sites/:siteID/members/:userID/2fa/reset", withAuth(h.guard(true), h.ResetMemberTwoFactor)...)
	// Self-service account settings. They are mounted outside /auth because they
	// operate on the caller's own account, not on the authentication surface.
	r.PATCH("/me/profile", withAuth(h.guard(true), h.UpdateProfile)...)
	r.POST("/me/email/verification", withAuth(h.credential, h.guard(false), h.RequestEmailVerification)...)
	// Account creation lives with authentication because it owns password hashing and
	// identity uniqueness; the path stays site scoped so the contract reads naturally.
	r.POST("/sites/:siteID/members", withAuth(h.CreateMemberAccount)...)
}

type registerRequest struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	// CaptchaToken is the solved human challenge. Optional because the site may
	// not require it; required (and refused when missing) when the site enables it.
	CaptchaToken string `json:"captcha_token"`
}

type loginRequest struct {
	// Identifier is the account email or the account display name. It is preferred
	// over Email; Email stays accepted for clients built against the older contract.
	Identifier string `json:"identifier"`
	Email      string `json:"email"`
	Password   string `json:"password"`
	// CaptchaToken is the solved human challenge; see registerRequest.
	CaptchaToken string `json:"captcha_token"`
}

type createMemberRequest struct {
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
	Role        string `json:"role"`
}

type passwordResetRequest struct {
	Email string `json:"email"`
	// CaptchaToken protects the "send me a link" step only: redeeming the emailed
	// token is already gated by that single-use secret, and a widget there would
	// strand a visitor whose challenge happened to expire.
	CaptchaToken string `json:"captcha_token"`
}

type passwordResetConfirmRequest struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

type updateProfileRequest struct {
	DisplayName   *string `json:"display_name"`
	Bio           *string `json:"bio"`
	AvatarMediaID *string `json:"avatar_media_id"`
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

type emailVerifyRequest struct {
	Token string `json:"token"`
}

// passwordResetPolicyResponse tells the client whether the reset flow can work.
//
// It is public and carries no secrets: the login page uses it to decide whether to
// offer the link or to explain that the operator has not configured mail yet.
type passwordResetPolicyResponse struct {
	Enabled   bool   `json:"enabled"`
	Delivery  string `json:"delivery"`
	ExpiresIn int    `json:"expires_in"`
	Cooldown  int    `json:"cooldown"`
}

// passwordResetRequestResponse is deliberately identical for every address: a
// caller must not be able to tell registered addresses from unknown ones.
type passwordResetRequestResponse struct {
	Status    string `json:"status"`
	Delivery  string `json:"delivery"`
	ExpiresIn int    `json:"expires_in"`
}

type memberResponse struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	Status      string `json:"status"`
	Email       string `json:"email"`
}

type userResponse struct {
	ID            string    `json:"id"`
	DisplayName   string    `json:"display_name"`
	Email         string    `json:"email,omitempty"`
	EmailVerified bool      `json:"email_verified"`
	Bio           string    `json:"bio,omitempty"`
	AvatarMediaID string    `json:"avatar_media_id,omitempty"`
	Locale        string    `json:"locale"`
	Status        string    `json:"status"`
	CreatedAt     time.Time `json:"created_at"`
}

// emailVerificationResponse reports what the resend endpoint did.
//
// already_verified is not an error: a verified account asking again is harmless,
// and telling it so is more useful than a silent accepted response.
type emailVerificationResponse struct {
	Status          string `json:"status"`
	Delivery        string `json:"delivery"`
	ExpiresIn       int    `json:"expires_in"`
	AlreadyVerified bool   `json:"already_verified"`
}

type sessionResponse struct {
	User             userResponse `json:"user"`
	TokenType        string       `json:"token_type"`
	AccessToken      string       `json:"access_token"`
	AccessExpiresAt  time.Time    `json:"access_expires_at"`
	RefreshExpiresAt time.Time    `json:"refresh_expires_at"`
	CSRFToken        string       `json:"csrf_token"`
}

// RegisterEmail creates an account and starts a session.
func (h *Handler) RegisterEmail(c *gin.Context) {
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	if !h.requireCaptcha(c, captcha.SceneRegister, req.CaptchaToken) {
		return
	}

	session, err := h.service.RegisterEmail(c.Request.Context(), h.siteID(c), RegisterEmailInput{
		Email:           req.Email,
		Password:        req.Password,
		DisplayName:     req.DisplayName,
		AllowFirstAdmin: h.firstAdmin != nil && h.firstAdmin(c),
		BaseURL:         requestOrigin(c, h.secure),
		ClientMeta:      clientMeta(c),
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	h.writeSession(c, http.StatusCreated, session)
}

// LoginPassword exchanges credentials for a session.
func (h *Handler) LoginPassword(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	if !h.requireCaptcha(c, captcha.SceneLogin, req.CaptchaToken) {
		return
	}

	session, err := h.service.LoginPassword(c.Request.Context(), h.siteID(c), LoginInput{
		Identifier: req.Identifier,
		Email:      req.Email,
		Password:   req.Password,
		ClientMeta: clientMeta(c),
	})
	if err != nil {
		// FSD F-04: a password-authenticated account with an active authenticator
		// gets a challenge, not a session. The response is a success (200) because the
		// password was correct; the client shows the second step.
		var challenge *TwoFactorRequiredError
		if errors.As(err, &challenge) {
			c.JSON(http.StatusOK, twoFactorChallengeResponse{
				TwoFactorRequired: true,
				ChallengeToken:    challenge.ChallengeToken,
				ExpiresIn:         int(TwoFactorChallengeTTL.Seconds()),
				ExpiresAt:         challenge.ExpiresAt.UTC(),
			})
			return
		}
		// A locked account answers 429 with Retry-After, matching the IP scoped
		// limiter's contract so the client can back off the same way for both tiers.
		var locked *TooManyAttemptsError
		if errors.As(err, &locked) {
			c.Header("Retry-After", retryAfterSeconds(locked.RetryAfter))
		}
		_ = c.Error(mapError(err))
		return
	}

	h.writeSession(c, http.StatusOK, session)
}

// retryAfterSeconds renders a lock duration as the whole seconds Retry-After wants.
func retryAfterSeconds(after time.Duration) string {
	seconds := int(after / time.Second)
	if after%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		seconds = 1
	}
	return strconv.Itoa(seconds)
}

// PasswordResetPolicy reports whether this deployment can deliver reset links.
func (h *Handler) PasswordResetPolicy(c *gin.Context) {
	policy := h.service.PasswordResetPolicy()
	delivery := policy.Delivery
	if delivery == "" {
		delivery = "email"
	}
	c.JSON(http.StatusOK, passwordResetPolicyResponse{
		Enabled:   policy.Enabled,
		Delivery:  delivery,
		ExpiresIn: int(policy.ExpiresIn.Seconds()),
		Cooldown:  int(policy.Cooldown.Seconds()),
	})
}

// RequestPasswordReset sends a reset link when the address has an account here.
//
// The response is identical in every case, including an unknown address and a
// failed delivery, so the endpoint cannot be used to enumerate accounts.
func (h *Handler) RequestPasswordReset(c *gin.Context) {
	var req passwordResetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	if !h.requireCaptcha(c, captcha.ScenePasswordReset, req.CaptchaToken) {
		return
	}

	_, err := h.service.RequestPasswordReset(
		c.Request.Context(),
		h.siteID(c),
		req.Email,
		requestOrigin(c, h.secure),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	// The nominal lifetime, never the remaining time: a computed value would differ
	// by a second between a real account and an unknown one, which is exactly the
	// enumeration signal this endpoint must not have.
	c.JSON(http.StatusAccepted, passwordResetRequestResponse{
		Status:    "accepted",
		Delivery:  "email",
		ExpiresIn: int(ResetTokenTTL.Seconds()),
	})
}

// ResetPassword redeems a reset link and replaces the account password.
func (h *Handler) ResetPassword(c *gin.Context) {
	var req passwordResetConfirmRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	if err := h.service.ResetPassword(c.Request.Context(), req.Token, req.Password); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Status(http.StatusNoContent)
}

// requireCaptcha enforces the site's human verification policy for one scene.
//
// It returns true when the request may continue. A failure has already been
// attached to the context as a problem, so the caller only has to return.
//
// The check runs before any password is hashed and before any session state is
// touched: a refused challenge must not cost an Argon2 hash, and it must not be
// observable in the login guard's counters.
func (h *Handler) requireCaptcha(c *gin.Context, scene captcha.Scene, token string) bool {
	if h.captcha == nil {
		return true
	}
	err := h.captcha.Require(c.Request.Context(), captcha.RequireInput{
		SiteID:    h.siteID(c),
		Scene:     scene,
		Token:     token,
		RemoteIP:  c.ClientIP(),
		RequestID: h.requestID(c),
	})
	if err == nil {
		return true
	}
	_ = c.Error(captcha.Problem(err))
	return false
}

// requestOrigin rebuilds the origin the browser used to reach this API.
//
// Only the Host header is trusted, never Origin or Referer: a reset link must never
// be pointed at an attacker supplied host. When TLS terminates in front of the API,
// SecureCookies is on, and https is the right scheme for the link.
func requestOrigin(c *gin.Context, secure bool) string {
	host := c.Request.Host
	if host == "" {
		return ""
	}
	if secure || c.Request.TLS != nil {
		return "https://" + host
	}
	return "http://" + host
}

// CreateMemberAccount creates a member account on the caller's site.
// It does not start a session: the administrator creates the account, then hands the
// initial password to the person who will use it.
func (h *Handler) CreateMemberAccount(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	var req createMemberRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	role := site.Role(req.Role)
	if role == "" {
		role = site.RoleMember
	}

	user, err := h.service.CreateMember(c.Request.Context(), principal, c.Param("siteID"), CreateMemberInput{
		Email:       req.Email,
		DisplayName: req.DisplayName,
		Password:    req.Password,
		Role:        role,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusCreated, memberResponse{
		UserID:      user.ID,
		DisplayName: user.DisplayName,
		Role:        string(role),
		Status:      user.Status,
		Email:       req.Email,
	})
}

// Refresh rotates the session using the refresh cookie and CSRF header.
func (h *Handler) Refresh(c *gin.Context) {
	refreshToken, err := c.Cookie(RefreshCookieName)
	if err != nil || refreshToken == "" {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_refresh_cookie"))
		return
	}

	// Double submit: the header must match the cookie. Checking this before the
	// database keeps CSRF attempts away from session state entirely.
	cookieCSRF, cookieErr := c.Cookie(CSRFCookieName)
	headerCSRF := c.GetHeader(CSRFHeaderName)
	if cookieErr != nil || cookieCSRF == "" || headerCSRF == "" || !TokensEqual(cookieCSRF, headerCSRF) {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "csrf_mismatch"))
		return
	}
	// A self-consistent pair is not enough: it must be the pair derived from this
	// exact refresh token. Otherwise a cookie writer could plant any equal pair (or
	// reuse the previous session's pair) and the double submit would degrade to a
	// global equality test (V-27). Still no session state is touched.
	if !TokensEqual(headerCSRF, h.service.CSRFToken(refreshToken)) {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "csrf_mismatch"))
		return
	}

	session, err := h.service.Refresh(c.Request.Context(), h.siteID(c), refreshToken)
	if err != nil {
		h.clearCookies(c)
		_ = c.Error(mapError(err))
		return
	}

	h.writeSession(c, http.StatusOK, session)
}

// Logout revokes the session and clears the cookies.
//
// Logout writes cookies, so it is a CSRF target too: a cross-site page must not be
// able to force a logout (and clear the victim's cookies) just by letting the browser
// attach them. When a refresh cookie is present the request therefore has to carry its
// matching derived CSRF pair, exactly like refresh. Without a refresh cookie there is
// nothing to revoke, and the handler keeps its tolerant "clear and answer 204"
// behaviour so retries and CLI callers are not broken.
func (h *Handler) Logout(c *gin.Context) {
	token, _ := c.Cookie(RefreshCookieName)

	if token != "" {
		cookieCSRF, cookieErr := c.Cookie(CSRFCookieName)
		headerCSRF := c.GetHeader(CSRFHeaderName)
		if cookieErr != nil || cookieCSRF == "" || headerCSRF == "" ||
			!TokensEqual(cookieCSRF, headerCSRF) ||
			!TokensEqual(headerCSRF, h.service.CSRFToken(token)) {
			_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "csrf_mismatch"))
			return
		}
	}

	if err := h.service.Logout(c.Request.Context(), token); err != nil {
		_ = c.Error(mapError(err))
		return
	}

	h.clearCookies(c)
	c.Status(http.StatusNoContent)
}

// Me returns the authenticated caller and its account.
func (h *Handler) Me(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	user, err := h.service.Me(c.Request.Context(), principal.UserID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	body := gin.H{
		"user":    toUserResponse(user),
		"role":    string(principal.Role),
		"site_id": principal.SiteID,
	}
	if h.groupKey != nil {
		// A custom group outranks the role mapping in the client: the matrix the
		// administrator assigned must drive the interface, not the base role.
		if key, keyErr := h.groupKey(c.Request.Context(), principal.SiteID, principal.UserID); keyErr == nil {
			body["group_key"] = key
		}
	}
	c.JSON(http.StatusOK, body)
}

// UpdateProfile applies a partial self-service profile update.
func (h *Handler) UpdateProfile(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	var req updateProfileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	user, err := h.service.UpdateProfile(c.Request.Context(), principal.UserID, principal.SiteID, ProfileInput{
		DisplayName:   req.DisplayName,
		Bio:           req.Bio,
		AvatarMediaID: req.AvatarMediaID,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toUserResponse(user))
}

// ChangePassword replaces the caller's password after re-proving the old one.
func (h *Handler) ChangePassword(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	var req changePasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	// The refresh cookie lets the service keep this session alive while revoking the
	// others. A missing cookie is not fatal; it just means every session is revoked.
	refreshToken, _ := c.Cookie(RefreshCookieName)
	if err := h.service.ChangePassword(
		c.Request.Context(),
		principal.UserID,
		principal.SiteID,
		refreshToken,
		req.CurrentPassword,
		req.NewPassword,
	); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Status(http.StatusNoContent)
}

// RequestEmailVerification sends a fresh verification link to the caller.
func (h *Handler) RequestEmailVerification(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	result, err := h.service.RequestEmailVerification(
		c.Request.Context(),
		principal.UserID,
		principal.SiteID,
		requestOrigin(c, h.secure),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	status := "accepted"
	if result.AlreadyVerified {
		status = "already_verified"
	}
	c.JSON(http.StatusAccepted, emailVerificationResponse{
		Status:          status,
		Delivery:        "email",
		ExpiresIn:       int(EmailVerificationTokenTTL.Seconds()),
		AlreadyVerified: result.AlreadyVerified,
	})
}

// VerifyEmail redeems a verification link.
func (h *Handler) VerifyEmail(c *gin.Context) {
	var req emailVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	if err := h.service.VerifyEmail(c.Request.Context(), req.Token); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Status(http.StatusNoContent)
}

// WriteSession renders a successful authentication response and sets its cookies.
//
// It is exported for the platform console's site handoff: redeeming a handoff token
// must produce exactly the same cookies, CSRF binding and JSON body as a password
// login, and duplicating that logic in another package is how the two drift apart.
func (h *Handler) WriteSession(c *gin.Context, status int, session Session) {
	h.writeSession(c, status, session)
}

func (h *Handler) writeSession(c *gin.Context, status int, session Session) {
	h.setCookies(c, session)

	c.JSON(status, sessionResponse{
		User:             toUserResponse(session.User),
		TokenType:        "Bearer",
		AccessToken:      session.AccessToken,
		AccessExpiresAt:  session.AccessExpiresAt.UTC(),
		RefreshExpiresAt: session.RefreshExpiresAt.UTC(),
		CSRFToken:        session.CSRFToken,
	})
}

// WriteSessionCookies sets the session cookies and writes no body.
//
// It is the cookie half of WriteSession, exported for a flow whose success answer is
// a redirect rather than a JSON document: a third party login must leave the browser
// holding exactly the cookies a password login leaves, so the same setCookies path is
// reused instead of a second implementation that could drift from it.
func (h *Handler) WriteSessionCookies(c *gin.Context, session Session) {
	h.setCookies(c, session)
}

func (h *Handler) setCookies(c *gin.Context, session Session) {
	maxAge := int(time.Until(session.RefreshExpiresAt).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}

	// SameSite=None is required for a cross site SPA and is only honoured together
	// with Secure; local HTTP development therefore uses Lax.
	sameSite := http.SameSiteLaxMode
	if h.secure {
		sameSite = http.SameSiteNoneMode
	}

	c.SetSameSite(sameSite)
	c.SetCookie(RefreshCookieName, session.RefreshToken, maxAge, RefreshCookiePath, h.domain, h.secure, true)

	c.SetSameSite(sameSite)
	c.SetCookie(CSRFCookieName, session.CSRFToken, maxAge, "/", h.domain, h.secure, false)
}

func (h *Handler) clearCookies(c *gin.Context) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(RefreshCookieName, "", -1, RefreshCookiePath, h.domain, h.secure, true)
	c.SetCookie(CSRFCookieName, "", -1, "/", h.domain, h.secure, false)
}

func clientMeta(c *gin.Context) ClientMeta {
	return ClientMeta{
		UserAgent: c.GetHeader("User-Agent"),
		IPAddress: c.ClientIP(),
	}
}

func toUserResponse(user UserView) userResponse {
	return userResponse{
		ID:            user.ID,
		DisplayName:   user.DisplayName,
		Email:         user.Email,
		EmailVerified: user.EmailVerified,
		Bio:           user.Bio,
		AvatarMediaID: user.AvatarMediaID,
		Locale:        user.Locale,
		Status:        user.Status,
		CreatedAt:     user.CreatedAt.UTC(),
	}
}

// mapError translates domain failures into the single error model the API exposes.
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
		return apperr.Validation(err.Error())

	case errors.Is(err, ErrIdentityExists):
		// V-29 residual: the status code still reveals that an address is registered.
		// Hiding it would break the SPA's duplicate account handling, so the trade-off
		// is an explicit code plus the credential rate limiter and the shared hashing
		// cost in RegisterEmail: this endpoint is not a fast oracle like the old login
		// timing channel was.
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "identity_exists").
			WithMessage("\u8be5\u90ae\u7bb1\u5df2\u88ab\u6ce8\u518c")

	case errors.Is(err, ErrEmailUnverified):
		return apperr.PermissionDenied().WithDetail("reason", "email_unverified")

	case errors.Is(err, ErrAccountDisabled):
		return apperr.PermissionDenied().WithDetail("reason", "account_disabled")

	case errors.Is(err, ErrInvalidCredentials), errors.Is(err, ErrAccountNotFound):
		return apperr.Unauthenticated().WithDetail("reason", "invalid_credentials")

	case errors.Is(err, ErrTooManyAttempts):
		// A distinct code (rather than unauthenticated) tells the client to back off
		// instead of showing "wrong password"; the payload is identical for known and
		// unknown addresses, so it is not an enumeration oracle.
		return apperr.RateLimited().WithDetail("reason", "too_many_attempts")

	case errors.Is(err, ErrInstallRequiresLocalAccess):
		return apperr.PermissionDenied().WithDetail("reason", "install_requires_local_access")

	case errors.Is(err, ErrRegistrationClosed):
		return apperr.PermissionDenied().
			WithDetail("reason", "registration_closed").
			WithMessage("本站暂未开放注册")

	case errors.Is(err, ErrResetTokenInvalid):
		// A reset link that no longer works is a client error the UI can explain
		// ("request a new one"), not an internal failure.
		return apperr.Validation("reset_token_invalid").
			WithMessage("重置链接无效或已过期，请重新获取。")

	case errors.Is(err, ErrEmailVerificationTokenInvalid):
		return apperr.Validation("email_verification_token_invalid").
			WithMessage("验证链接无效或已过期，请重新获取。")

	// Phone login (contract A). Both are phone only; a password path never produces
	// them, so the shared table can carry them without changing existing responses.
	case errors.Is(err, ErrInvalidCode):
		return invalidCodeProblem()

	case errors.Is(err, ErrSMSNotConfigured):
		return smsNotConfiguredProblem()

	case errors.Is(err, ErrCurrentPasswordInvalid):
		return apperr.ValidationField("current password is incorrect", "current_password", "invalid").
			WithMessage("当前密码不正确。")

	// A rejected step-up password is not an expired session: answering 401 would make
	// the SPA sign the caller out for a typo. The documented reason tells the client
	// to keep the session and show the password dialog again.
	case errors.Is(err, ErrStepUpPasswordRejected):
		return apperr.PermissionDenied().WithDetail("reason", "step_up_password_rejected")

	case errors.Is(err, ErrStepUpUnavailable):
		// Fail closed: without a signer there is no way to mint a grant, and letting
		// the high threat operation through would defeat the feature.
		return apperr.Internal(err)

	case errors.Is(err, ErrPasswordUnchanged):
		return apperr.Validation("new_password_unchanged").
			WithDetail("field", "new_password").
			WithMessage("新密码不能与当前密码相同。")

	case errors.Is(err, ErrAvatarInvalid):
		return apperr.ValidationField("avatar asset is invalid", "avatar_media_id", "invalid")

	case errors.Is(err, ErrMailNotConfigured):
		return apperr.New(apperr.CodeEmailNotConfigured).WithDetail("reason", "smtp_not_configured")

	case errors.Is(err, ErrRefreshReuse):
		return apperr.Unauthenticated().WithDetail("reason", "refresh_reuse")

	// Two-factor failures. A wrong code on an authenticated management endpoint must
	// not answer 401: the SPA treats 401 as an expired session and would sign the
	// caller out for a typo. Only the challenge itself (no session exists yet) is
	// unauthenticated.
	case errors.Is(err, ErrTwoFactorChallengeInvalid):
		return apperr.Unauthenticated().WithDetail("reason", "two_factor_challenge_invalid")

	case errors.Is(err, ErrInvalidTwoFactorCode):
		return apperr.Validation("invalid_two_factor_code").
			WithDetail("field", "code").
			WithDetail("rule", "invalid").
			WithDetail("reason", "invalid_two_factor_code")

	case errors.Is(err, ErrTwoFactorReplayed):
		return apperr.Validation("two_factor_code_already_used").
			WithDetail("field", "code").
			WithDetail("rule", "already_used").
			WithDetail("reason", "two_factor_code_already_used")

	case errors.Is(err, ErrTwoFactorAlreadyEnabled):
		return apperr.Conflict(apperr.CodeConflict).WithDetail("reason", "two_factor_already_enabled")

	case errors.Is(err, ErrTwoFactorNotEnabled):
		return apperr.Conflict(apperr.CodeConflict).WithDetail("reason", "two_factor_not_enabled")

	case errors.Is(err, ErrTwoFactorNotEnrolled):
		return apperr.Validation("two_factor_not_enrolled").
			WithDetail("reason", "two_factor_not_enrolled")

	case errors.Is(err, ErrTwoFactorUnavailable):
		// The sealed secret cannot be opened (normally a rotated signing key). The
		// account has to enroll again; answering 500 would suggest a transient outage.
		return apperr.Conflict(apperr.CodeConflict).WithDetail("reason", "two_factor_secret_unreadable")

	case errors.Is(err, ErrSessionRevoked), errors.Is(err, ErrSessionNotFound):
		return apperr.Unauthenticated().WithDetail("reason", "session_revoked")

	case errors.Is(err, ErrCSRFMismatch):
		return apperr.PermissionDenied().WithDetail("reason", "csrf_mismatch")

	case errors.Is(err, ErrPermissionToSite):
		return apperr.PermissionDenied().WithDetail("reason", "not_a_member")

	case errors.Is(err, ErrActionNotAllowed):
		return apperr.PermissionDenied().WithDetail("reason", "role_too_low")

	case errors.Is(err, ErrSiteMissing):
		return apperr.New(apperr.CodeSiteNotFound)

	case errors.Is(err, ErrInvalidToken), errors.Is(err, ErrTokenExpired):
		return apperr.Unauthenticated().WithDetail("reason", "token_invalid")
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}
