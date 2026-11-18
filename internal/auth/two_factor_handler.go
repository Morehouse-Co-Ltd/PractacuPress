package auth

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
)

// Two-factor authentication HTTP surface (FSD F-04).
//
// The self-service routes live under /me/2fa because they act on the caller's own
// account; the challenge redemption lives under /auth/login/2fa because it belongs
// to the login flow, and the administrator reset lives with the member routes it
// operates on.

type twoFactorStatusResponse struct {
	Enabled                bool       `json:"enabled"`
	RecoveryCodesRemaining int        `json:"recovery_codes_remaining"`
	ConfirmedAt            *time.Time `json:"confirmed_at,omitempty"`
}

type twoFactorEnrollRequest struct {
	Password string `json:"password"`
}

type twoFactorEnrollResponse struct {
	Secret     string `json:"secret"`
	OTPAuthURI string `json:"otpauth_uri"`
	QRContent  string `json:"qr_content"`
	ExpiresIn  int    `json:"expires_in"`
}

type twoFactorCodeRequest struct {
	Code string `json:"code"`
}

type twoFactorPasswordCodeRequest struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}

type twoFactorRecoveryCodesResponse struct {
	RecoveryCodes []string `json:"recovery_codes"`
}

// twoFactorChallengeResponse is the login answer for a 2FA protected account.
//
// It is deliberately not a Session: no access token, refresh cookie or CSRF value
// is issued until the second factor is proven.
type twoFactorChallengeResponse struct {
	TwoFactorRequired bool      `json:"two_factor_required"`
	ChallengeToken    string    `json:"challenge_token"`
	ExpiresIn         int       `json:"expires_in"`
	ExpiresAt         time.Time `json:"expires_at"`
}

type loginTwoFactorRequest struct {
	ChallengeToken string `json:"challenge_token"`
	Code           string `json:"code"`
}

// TwoFactorStatus reports the caller's own enrollment state.
func (h *Handler) TwoFactorStatus(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	status, err := h.service.TwoFactorStatus(c.Request.Context(), principal.UserID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, twoFactorStatusResponse{
		Enabled:                status.Enabled,
		RecoveryCodesRemaining: status.RecoveryCodesRemaining,
		ConfirmedAt:            status.ConfirmedAt,
	})
}

// BeginTwoFactorEnrollment mints a pending secret and its otpauth URI.
func (h *Handler) BeginTwoFactorEnrollment(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	var req twoFactorEnrollRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	enrollment, err := h.service.BeginTwoFactorEnrollment(
		c.Request.Context(), principal.UserID, principal.SiteID, req.Password,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, twoFactorEnrollResponse{
		Secret:     enrollment.Secret,
		OTPAuthURI: enrollment.OTPAuthURI,
		QRContent:  enrollment.QRContent,
		ExpiresIn:  int(twoFactorEnrollmentTTL.Seconds()),
	})
}

// ConfirmTwoFactor enables the authenticator and returns the recovery codes once.
func (h *Handler) ConfirmTwoFactor(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	var req twoFactorCodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	codes, err := h.service.ConfirmTwoFactor(
		c.Request.Context(), principal.UserID, principal.SiteID, req.Code,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, twoFactorRecoveryCodesResponse{RecoveryCodes: codes})
}

// DisableTwoFactor turns the caller's authenticator off.
func (h *Handler) DisableTwoFactor(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	var req twoFactorPasswordCodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	if err := h.service.DisableTwoFactor(
		c.Request.Context(), principal.UserID, principal.SiteID, req.Password, req.Code,
	); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Status(http.StatusNoContent)
}

// RegenerateTwoFactorRecoveryCodes replaces and returns a fresh recovery code set.
func (h *Handler) RegenerateTwoFactorRecoveryCodes(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	var req twoFactorPasswordCodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	codes, err := h.service.RegenerateTwoFactorRecoveryCodes(
		c.Request.Context(), principal.UserID, principal.SiteID, req.Password, req.Code,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, twoFactorRecoveryCodesResponse{RecoveryCodes: codes})
}

// LoginTwoFactor redeems a password login's challenge with a code or recovery code.
func (h *Handler) LoginTwoFactor(c *gin.Context) {
	var req loginTwoFactorRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	session, err := h.service.VerifyTwoFactorLogin(
		c.Request.Context(),
		h.siteID(c),
		req.ChallengeToken,
		req.Code,
		clientMeta(c),
	)
	if err != nil {
		var locked *TooManyAttemptsError
		if errors.As(err, &locked) {
			c.Header("Retry-After", retryAfterSeconds(locked.RetryAfter))
		}
		_ = c.Error(mapError(err))
		return
	}

	h.writeSession(c, http.StatusOK, session)
}

// ResetMemberTwoFactor clears another account's authenticator (platform admin).
func (h *Handler) ResetMemberTwoFactor(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
	if err := h.service.ResetMemberTwoFactor(
		c.Request.Context(), principal, c.Param("siteID"), c.Param("userID"),
	); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Status(http.StatusNoContent)
}

// twoFactorEnrollmentTTL is the advertised lifetime of a pending enrollment.
//
// It is advisory rather than enforced: a pending secret is inert until confirmed,
// and restarting an enrollment replaces it. The client shows the QR for as long as
// the user needs to scan it.
const twoFactorEnrollmentTTL = 15 * time.Minute
