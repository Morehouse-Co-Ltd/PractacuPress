package captcha

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/errors"
)

// PolicyReader reports the effective captcha rule of a site.
//
// *Guard implements it. The interface exists so the status endpoint can be tested
// without a verifier or a database.
type PolicyReader interface {
	Policy(ctx context.Context, siteID string) (Policy, error)
}

// HandlerConfig configures the public captcha endpoints.
type HandlerConfig struct {
	// Policy reports the effective rule. Nil answers "off".
	Policy PolicyReader
	// Local serves the self-hosted picture challenges. Nil answers 503 on the
	// local endpoints, which is what a process that does not run the local provider
	// should say.
	Local *LocalStore
	// SiteID resolves the site the request belongs to.
	SiteID func(*gin.Context) string
	// RequestID returns the correlation id, for the problem payload.
	RequestID func(*gin.Context) string
	// Now is the clock, for tests.
	Now func() time.Time
}

// Handler serves the public captcha endpoints.
type Handler struct {
	policy    PolicyReader
	local     *LocalStore
	siteID    func(*gin.Context) string
	requestID func(*gin.Context) string
	now       func() time.Time
}

// NewHandler builds a Handler.
func NewHandler(cfg HandlerConfig) *Handler {
	siteID := cfg.SiteID
	if siteID == nil {
		siteID = func(*gin.Context) string { return "" }
	}
	requestID := cfg.RequestID
	if requestID == nil {
		requestID = func(*gin.Context) string { return "" }
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Handler{
		policy:    cfg.Policy,
		local:     cfg.Local,
		siteID:    siteID,
		requestID: requestID,
		now:       now,
	}
}

// Routes mounts the endpoints under /api/v1.
//
// They are public on purpose: the login, registration and password reset forms have
// to know whether to draw a widget *before* the visitor has a session, and the
// payload contains nothing a visitor cannot already read from the design
// document. The one server-only fact the status endpoint exposes is a boolean:
// whether this process can verify the selected provider. That is exactly what the
// forms and the settings page need in order to stop promising a check that is not
// applied.
func (h *Handler) Routes(r gin.IRouter) {
	r.GET("/captcha/status", h.Status)
	// The local provider issues and solves its challenge here. The resulting token
	// is then submitted to the protected endpoint exactly like a third party token.
	r.GET("/captcha/local/challenge", h.LocalChallenge)
	r.POST("/captcha/local/verify", h.LocalVerify)
}

// statusResponse is the effective rule a browser may rely on.
type statusResponse struct {
	// Enabled is the site's stored switch.
	Enabled bool `json:"enabled"`
	// Provider is the selected service.
	Provider string `json:"provider"`
	// SiteKey is the public widget key, empty when the site never saved one.
	SiteKey string `json:"site_key"`
	// Scenes lists the scenes that are really enforced right now.
	Scenes map[string]bool `json:"scenes"`
	// ServerConfigured reports whether the process holds the provider secret.
	ServerConfigured bool `json:"server_configured"`
	// Effective is true only when the check really runs; forms must render a
	// widget only in that case.
	Effective bool `json:"effective"`
	// CheckedAt tells the settings page how fresh this answer is.
	CheckedAt time.Time `json:"checked_at"`
}

// Status reports whether this deployment enforces the site's captcha settings.
func (h *Handler) Status(c *gin.Context) {
	requestID := h.requestID(c)
	if h.policy == nil {
		c.JSON(http.StatusOK, statusResponse{
			Provider:  string(ProviderTurnstile),
			Scenes:    Policy{Settings: DefaultSettings()}.Scenes(),
			CheckedAt: h.now().UTC(),
		})
		return
	}

	policy, err := h.policy.Policy(c.Request.Context(), h.siteID(c))
	if err != nil {
		problem := apperr.New(apperr.CodeSecurityUnavailable).
			WithDetail("reason", Reason(ErrPolicyUnavailable)).
			WithRequestID(requestID)
		_ = c.Error(problem)
		return
	}

	provider := policy.Settings.Provider
	if !provider.Valid() {
		provider = ProviderTurnstile
	}
	body := statusResponse{
		Enabled:          policy.Settings.Enabled,
		Provider:         string(provider),
		SiteKey:          policy.Settings.SiteKey,
		Scenes:           policy.Scenes(),
		ServerConfigured: policy.SecretConfigured,
		Effective:        policy.Effective,
		CheckedAt:        h.now().UTC(),
	}
	// One short cache: the settings page re-reads this after saving, and a stale
	// answer there is an operator surprise. Everything else is immutable enough
	// that no cache is worth the staleness.
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, body)
}
