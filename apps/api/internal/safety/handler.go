package safety

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	Principal PrincipalFunc
}

// Handler exposes the content safety configuration over HTTP.
//
// The routes live under /sites/{siteID}/safety because the policy is site state,
// exactly like the comment switches. Every route requires a session; the service
// additionally requires site administrator authority on the site in the path.
type Handler struct {
	service   *Service
	principal PrincipalFunc
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (Actor, bool) { return Actor{}, false }
	}
	return &Handler{service: service, principal: principal}
}

// Routes mounts the safety endpoints under /api/v1.
//
// protected carries the extra middleware the transport wants on these routes,
// notably the step-up guard: deleting a word or an IP rule changes enforcement for
// every visitor, so it is one of the high threat operations.
func (h *Handler) Routes(r gin.IRouter, requireAuth gin.HandlerFunc, protected ...gin.HandlerFunc) {
	guards := append([]gin.HandlerFunc{requireAuth}, protected...)
	group := r.Group("/sites/:siteID/safety", guards...)
	group.GET("", h.GetPolicy)
	group.PATCH("", h.UpdateRateLimit)
	group.POST("/words", h.CreateWord)
	group.PATCH("/words/:wordID", h.UpdateWord)
	group.DELETE("/words/:wordID", h.DeleteWord)
	group.POST("/ip-rules", h.CreateIPRule)
	group.DELETE("/ip-rules/:ruleID", h.DeleteIPRule)
}

type rateLimitResponse struct {
	UserPerWindow int `json:"user_per_window"`
	IPPerWindow   int `json:"ip_per_window"`
	WindowSeconds int `json:"window_seconds"`
}

type wordResponse struct {
	ID          string    `json:"id"`
	Word        string    `json:"word"`
	Mode        string    `json:"mode"`
	Replacement string    `json:"replacement"`
	Enabled     bool      `json:"enabled"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type ipRuleResponse struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Value     string    `json:"value"`
	Note      string    `json:"note,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type safetyPolicyResponse struct {
	RateLimit rateLimitResponse `json:"rate_limit"`
	Words     []wordResponse    `json:"words"`
	IPRules   []ipRuleResponse  `json:"ip_rules"`
}

type createWordRequest struct {
	Word        string `json:"word"`
	Mode        string `json:"mode"`
	Replacement string `json:"replacement"`
	Enabled     *bool  `json:"enabled"`
}

type updateWordRequest struct {
	Mode        *string `json:"mode"`
	Replacement *string `json:"replacement"`
	Enabled     *bool   `json:"enabled"`
}

type createIPRuleRequest struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
	Note  string `json:"note"`
}

type updateRateLimitRequest struct {
	UserPerWindow *int `json:"user_per_window"`
	IPPerWindow   *int `json:"ip_per_window"`
	WindowSeconds *int `json:"window_seconds"`
}

// GetPolicy returns the safety configuration of one site.
func (h *Handler) GetPolicy(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(nil))
		return
	}
	siteID := c.Param("siteID")

	words, err := h.service.ListWords(c.Request.Context(), actor, siteID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	rules, err := h.service.ListIPRules(c.Request.Context(), actor, siteID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	rate, err := h.service.RateLimit(c.Request.Context(), actor, siteID)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	response := safetyPolicyResponse{
		RateLimit: rateLimitView(rate),
		Words:     make([]wordResponse, 0, len(words)),
		IPRules:   make([]ipRuleResponse, 0, len(rules)),
	}
	for _, word := range words {
		response.Words = append(response.Words, toWordResponse(word))
	}
	for _, rule := range rules {
		response.IPRules = append(response.IPRules, toIPRuleResponse(rule))
	}
	c.JSON(http.StatusOK, response)
}

// UpdateRateLimit changes the comment frequency limits.
func (h *Handler) UpdateRateLimit(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(nil))
		return
	}

	var req updateRateLimitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	config, err := h.service.UpdateRateLimit(c.Request.Context(), actor, c.Param("siteID"), RateLimitInput{
		UserLimit:     req.UserPerWindow,
		IPLimit:       req.IPPerWindow,
		WindowSeconds: req.WindowSeconds,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, rateLimitView(config))
}

// CreateWord adds a sensitive word.
func (h *Handler) CreateWord(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(nil))
		return
	}

	var req createWordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	word, err := h.service.CreateWord(c.Request.Context(), actor, c.Param("siteID"), WordInput{
		Word:        req.Word,
		Mode:        WordMode(req.Mode),
		Replacement: req.Replacement,
		Enabled:     req.Enabled,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusCreated, toWordResponse(word))
}

// UpdateWord changes the action of an existing word.
func (h *Handler) UpdateWord(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(nil))
		return
	}

	var req updateWordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	update := WordUpdate{Enabled: req.Enabled}
	if req.Mode != nil {
		mode := WordMode(*req.Mode)
		update.Mode = &mode
	}
	update.Replacement = req.Replacement

	word, err := h.service.UpdateWord(
		c.Request.Context(), actor, c.Param("siteID"), c.Param("wordID"), update,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusOK, toWordResponse(word))
}

// DeleteWord removes a sensitive word.
func (h *Handler) DeleteWord(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(nil))
		return
	}
	if err := h.service.DeleteWord(
		c.Request.Context(), actor, c.Param("siteID"), c.Param("wordID"),
	); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Status(http.StatusNoContent)
}

// CreateIPRule adds an allow or deny entry.
func (h *Handler) CreateIPRule(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(nil))
		return
	}

	var req createIPRuleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}
	rule, err := h.service.CreateIPRule(c.Request.Context(), actor, c.Param("siteID"), IPRuleInput{
		Kind:  IPRuleKind(req.Kind),
		Value: req.Value,
		Note:  req.Note,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.JSON(http.StatusCreated, toIPRuleResponse(rule))
}

// DeleteIPRule removes an allow or deny entry.
func (h *Handler) DeleteIPRule(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}
	if h.service == nil {
		_ = c.Error(apperr.Internal(nil))
		return
	}
	if err := h.service.DeleteIPRule(
		c.Request.Context(), actor, c.Param("siteID"), c.Param("ruleID"),
	); err != nil {
		_ = c.Error(mapError(err))
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *Handler) unauthenticated(c *gin.Context) {
	_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
}

func rateLimitView(config RateConfig) rateLimitResponse {
	normalized := config.Normalize()
	return rateLimitResponse{
		UserPerWindow: normalized.UserLimit,
		IPPerWindow:   normalized.IPLimit,
		WindowSeconds: int(normalized.Window / time.Second),
	}
}

func toWordResponse(word SensitiveWord) wordResponse {
	return wordResponse{
		ID:          word.ID,
		Word:        word.Word,
		Mode:        string(word.Mode),
		Replacement: word.Replacement,
		Enabled:     word.Enabled,
		CreatedAt:   word.CreatedAt,
		UpdatedAt:   word.UpdatedAt,
	}
}

func toIPRuleResponse(rule IPRule) ipRuleResponse {
	return ipRuleResponse{
		ID:        rule.ID,
		Kind:      string(rule.Kind),
		Value:     rule.Value,
		Note:      rule.Note,
		CreatedAt: rule.CreatedAt,
	}
}

// mapError translates safety failures into the API error model.
func mapError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation("invalid safety configuration")
	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("safety configuration")
	case errors.Is(err, ErrConflict):
		return apperr.New(apperr.CodeConflict).WithDetail("reason", "already_configured")
	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()
	}
	return apperr.Internal(err)
}
