package site

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// stepUpStatusResponse is the masked step-up settings payload.
type stepUpStatusResponse struct {
	Enabled       bool `json:"enabled"`
	PasswordSet   bool `json:"password_set"`
	WindowSeconds int  `json:"window_seconds"`
}

// stepUpUpdateRequest is a partial update of the settings.
//
// Password is a pointer so an omitted property keeps the stored dedicated
// password; clear_password removes it explicitly.
type stepUpUpdateRequest struct {
	Enabled       *bool   `json:"enabled"`
	Password      *string `json:"password"`
	ClearPassword bool    `json:"clear_password"`
}

// GetStepUp returns the masked step-up settings of the site.
func (h *Handler) GetStepUp(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	status, err := h.service.StepUpStatus(c.Request.Context(), actor, actor.SiteID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	// A security setting is never stored by a shared cache.
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, toStepUpStatusResponse(status))
}

// UpdateStepUp changes the step-up settings of the site.
//
// The first save of a fresh site is accepted without a grant; every later change
// must carry a valid X-PP-Step-Up token, minted by POST /auth/step-up.
func (h *Handler) UpdateStepUp(c *gin.Context) {
	actor, ok := h.actor(c, c.Param("siteID"))
	if !ok {
		return
	}

	var req stepUpUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	status, err := h.service.UpdateStepUpSettings(
		c.Request.Context(),
		actor,
		actor.SiteID,
		StepUpSettingsInput{
			Enabled:       req.Enabled,
			Password:      req.Password,
			ClearPassword: req.ClearPassword,
		},
		c.GetHeader(StepUpHeaderName),
		h.requestID(c),
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, toStepUpStatusResponse(status))
}

// toStepUpStatusResponse renders the masked settings.
func toStepUpStatusResponse(status StepUpStatus) stepUpStatusResponse {
	return stepUpStatusResponse{
		Enabled:       status.Enabled,
		PasswordSet:   status.PasswordSet,
		WindowSeconds: status.WindowSeconds,
	}
}
