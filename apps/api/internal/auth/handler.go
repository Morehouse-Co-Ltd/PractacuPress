package auth

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
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
}

// Handler exposes the authentication use cases over HTTP.
type Handler struct {
	service   *Service
	secure    bool
	domain    string
	siteID    SiteIDFunc
	principal PrincipalFunc
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
	return &Handler{
		service:   service,
		secure:    cfg.SecureCookies,
		domain:    cfg.CookieDomain,
		siteID:    siteID,
		principal: principal,
	}
}

// Routes mounts the authentication endpoints under /api/v1.
//
// requireAuth guards only GET /me: registration, login and refresh must work without
// an access token, and logout must work with an expired one.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc) {
	group := r.Group("/auth")
	group.POST("/register/email", h.RegisterEmail)
	group.POST("/login/password", h.LoginPassword)
	group.POST("/token/refresh", h.Refresh)
	group.POST("/logout", h.Logout)

	r.GET("/me", requireAuth, h.Me)
}

type registerRequest struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type userResponse struct {
	ID          string    `json:"id"`
	DisplayName string    `json:"display_name"`
	Locale      string    `json:"locale"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
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

	session, err := h.service.RegisterEmail(c.Request.Context(), h.siteID(c), RegisterEmailInput{
		Email:       req.Email,
		Password:    req.Password,
		DisplayName: req.DisplayName,
		ClientMeta:  clientMeta(c),
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

	session, err := h.service.LoginPassword(c.Request.Context(), h.siteID(c), LoginInput{
		Email:      req.Email,
		Password:   req.Password,
		ClientMeta: clientMeta(c),
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	h.writeSession(c, http.StatusOK, session)
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

	session, err := h.service.Refresh(c.Request.Context(), h.siteID(c), refreshToken)
	if err != nil {
		h.clearCookies(c)
		_ = c.Error(mapError(err))
		return
	}

	h.writeSession(c, http.StatusOK, session)
}

// Logout revokes the session and clears the cookies.
func (h *Handler) Logout(c *gin.Context) {
	token, _ := c.Cookie(RefreshCookieName)

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

	c.JSON(http.StatusOK, gin.H{
		"user":    toUserResponse(user),
		"role":    string(principal.Role),
		"site_id": principal.SiteID,
	})
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
		ID:          user.ID,
		DisplayName: user.DisplayName,
		Locale:      user.Locale,
		Status:      user.Status,
		CreatedAt:   user.CreatedAt.UTC(),
	}
}

// mapError translates domain failures into the single error model the API exposes.
func mapError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil

	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation(err.Error())

	case errors.Is(err, ErrIdentityExists):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "identity_exists").
			WithMessage("\u8be5\u90ae\u7bb1\u5df2\u88ab\u6ce8\u518c")

	case errors.Is(err, ErrEmailUnverified):
		return apperr.PermissionDenied().WithDetail("reason", "email_unverified")

	case errors.Is(err, ErrAccountDisabled):
		return apperr.PermissionDenied().WithDetail("reason", "account_disabled")

	case errors.Is(err, ErrInvalidCredentials), errors.Is(err, ErrAccountNotFound):
		return apperr.Unauthenticated().WithDetail("reason", "invalid_credentials")

	case errors.Is(err, ErrRefreshReuse):
		return apperr.Unauthenticated().WithDetail("reason", "refresh_reuse")

	case errors.Is(err, ErrSessionRevoked), errors.Is(err, ErrSessionNotFound):
		return apperr.Unauthenticated().WithDetail("reason", "session_revoked")

	case errors.Is(err, ErrCSRFMismatch):
		return apperr.PermissionDenied().WithDetail("reason", "csrf_mismatch")

	case errors.Is(err, ErrPermissionToSite):
		return apperr.PermissionDenied().WithDetail("reason", "not_a_member")

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

