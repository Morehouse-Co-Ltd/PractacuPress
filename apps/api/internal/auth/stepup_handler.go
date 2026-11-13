package auth

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// stepUpVerifyRequest is the password the caller re-enters for a high threat
// operation. The password is never echoed back and never logged.
type stepUpVerifyRequest struct {
	Password string `json:"password"`
}

// stepUpGrantResponse is the short lived grant the protected request then carries
// in its X-PP-Step-Up header.
type stepUpGrantResponse struct {
	Token     string `json:"token"`
	ExpiresIn int    `json:"expires_in"`
}

// VerifyStepUp re-proves the caller's password and mints a step-up grant.
//
// The check order is documented on site.Service.UpdateStepUpSettings and
// Service.VerifyStepUpPassword: the site's dedicated security password first, the
// account login password otherwise. The handler sits behind the credential limiter
// so password guessing against this endpoint is throttled exactly like login.
func (h *Handler) VerifyStepUp(c *gin.Context) {
	principal, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	var req stepUpVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	token, expiresIn, err := h.service.VerifyStepUpPassword(
		c.Request.Context(), principal.UserID, principal.SiteID, req.Password,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	// A grant is a credential: never let a shared cache or the browser's HTTP cache
	// keep it.
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, stepUpGrantResponse{Token: token, ExpiresIn: expiresIn})
}
