package captcha

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// localChallengeResponse is the question a browser renders.
type localChallengeResponse struct {
	ChallengeID string    `json:"challenge_id"`
	Question    string    `json:"question"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// localVerifyResponse is the solved token the protected form submits.
type localVerifyResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

// localVerifyRequest is the answer to one issued question.
type localVerifyRequest struct {
	ChallengeID string `json:"challenge_id"`
	Scene       string `json:"scene"`
	// Answer is a pointer so an omitted answer is distinguishable from a wrong one.
	// Both are refused, but only the wrong one burns the challenge in the store.
	Answer *int `json:"answer"`
}

// LocalChallenge issues a self-hosted arithmetic challenge.
//
// The response is public and self-contained: it carries no secret, and the answer
// only lives in this process's memory. A deployment that does not wire the local
// store answers 503 rather than handing out a challenge it cannot verify.
func (h *Handler) LocalChallenge(c *gin.Context) {
	requestID := h.requestID(c)
	if h.local == nil {
		_ = c.Error(localUnavailableProblem(requestID))
		return
	}

	rawScene := strings.TrimSpace(c.Query("scene"))
	if rawScene == "" {
		_ = c.Error(apperr.ValidationField("scene is required", "scene", "required").
			WithDetail("reason", "scene_required").
			WithRequestID(requestID))
		return
	}
	scene := Scene(rawScene)
	if !scene.Valid() {
		_ = c.Error(apperr.ValidationField("scene is unknown", "scene", "invalid").
			WithDetail("reason", "scene_invalid").
			WithRequestID(requestID))
		return
	}

	challenge, err := h.local.Issue(scene)
	if err != nil {
		_ = c.Error(localProblem(err, requestID))
		return
	}

	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, localChallengeResponse{
		ChallengeID: challenge.ID,
		Question:    challenge.Question,
		ExpiresAt:   challenge.ExpiresAt.UTC(),
	})
}

// LocalVerify checks the answer and mints the one-shot token.
//
// The challenge is single use: a wrong answer consumes it too, so a script cannot
// probe one question until it hits the right number. The browser simply requests a
// new challenge and tries again.
func (h *Handler) LocalVerify(c *gin.Context) {
	requestID := h.requestID(c)
	if h.local == nil {
		_ = c.Error(localUnavailableProblem(requestID))
		return
	}

	var req localVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body").WithRequestID(requestID))
		return
	}
	challengeID := strings.TrimSpace(req.ChallengeID)
	if challengeID == "" {
		_ = c.Error(apperr.ValidationField("challenge id is required", "challenge_id", "required").
			WithDetail("reason", "challenge_required").
			WithRequestID(requestID))
		return
	}
	rawScene := strings.TrimSpace(req.Scene)
	if rawScene == "" {
		_ = c.Error(apperr.ValidationField("scene is required", "scene", "required").
			WithDetail("reason", "scene_required").
			WithRequestID(requestID))
		return
	}
	scene := Scene(rawScene)
	if !scene.Valid() {
		_ = c.Error(apperr.ValidationField("scene is unknown", "scene", "invalid").
			WithDetail("reason", "scene_invalid").
			WithRequestID(requestID))
		return
	}
	if req.Answer == nil {
		_ = c.Error(apperr.ValidationField("answer is required", "answer", "required").
			WithDetail("reason", "answer_required").
			WithRequestID(requestID))
		return
	}

	token, expiresAt, err := h.local.Solve(challengeID, *req.Answer, scene)
	if err != nil {
		_ = c.Error(localProblem(err, requestID))
		return
	}

	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, localVerifyResponse{Token: token, ExpiresAt: expiresAt.UTC()})
}

// localUnavailableProblem is the answer of a process that does not run the local
// provider. It matches the status endpoint's "not effective" report: the form would
// not render a local challenge, so a direct call is an operator mistake.
func localUnavailableProblem(requestID string) *apperr.Problem {
	return apperr.New(apperr.CodeSecurityUnavailable).
		WithDetail("reason", "captcha_unavailable").
		WithMessage("本站没有启用本地人机验证。").
		WithRequestID(requestID)
}

// localProblem maps a store failure onto the same problem vocabulary as the
// provider path: retryable when the service is unavailable, a validation error when
// the visitor has to solve the challenge again.
func localProblem(err error, requestID string) *apperr.Problem {
	switch {
	case errors.Is(err, ErrNotConfigured):
		return localUnavailableProblem(requestID)
	case errors.Is(err, ErrRejected), errors.Is(err, ErrActionMismatch):
		return apperr.ValidationField("local challenge was rejected", "answer", "invalid").
			WithDetail("reason", Reason(err)).
			WithMessage("验证答案不正确或已过期，请换一题重试。").
			WithRequestID(requestID)
	case errors.Is(err, ErrTokenMissing):
		return apperr.ValidationField("challenge id is required", "challenge_id", "required").
			WithDetail("reason", Reason(err)).
			WithRequestID(requestID)
	default:
		return apperr.Internal(err).
			WithDetail("reason", Reason(err)).
			WithRequestID(requestID)
	}
}
