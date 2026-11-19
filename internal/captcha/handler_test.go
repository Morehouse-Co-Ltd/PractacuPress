package captcha

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/errors"
)

type stubPolicy struct {
	policy Policy
	err    error
}

func (s stubPolicy) Policy(context.Context, string) (Policy, error) {
	return s.policy, s.err
}

func serveStatus(t *testing.T, reader PolicyReader) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(gin.CustomRecovery(func(c *gin.Context, _ any) {
		c.Status(http.StatusInternalServerError)
	}))
	// The problem handler the real router installs.
	engine.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) == 0 {
			return
		}
		problem, ok := c.Errors[0].Err.(*apperr.Problem)
		if !ok {
			return
		}
		c.AbortWithStatusJSON(problem.Status, problem)
	})
	handler := NewHandler(HandlerConfig{
		Policy:    reader,
		SiteID:    func(*gin.Context) string { return "site" },
		RequestID: func(*gin.Context) string { return "req-1" },
		Now:       func() time.Time { return time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC) },
	})
	handler.Routes(engine.Group("/api/v1"))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/captcha/status", nil)
	engine.ServeHTTP(recorder, request)
	return recorder
}

func TestStatusReportsAnUnenforcedSite(t *testing.T) {
	recorder := serveStatus(t, stubPolicy{policy: Policy{
		Settings: Settings{
			Enabled:  true,
			Provider: ProviderTurnstile,
			SiteKey:  "site-key",
			OnLogin:  true,
		},
		SecretConfigured: false,
		Effective:        false,
	}})

	require.Equal(t, http.StatusOK, recorder.Code)
	var body statusResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	// The site asked for a challenge but this deployment cannot run one. Reporting
	// effective=true here is exactly the lie the settings page used to tell.
	require.True(t, body.Enabled)
	require.False(t, body.Effective)
	require.False(t, body.ServerConfigured)
	require.False(t, body.Scenes["login"])
	require.Equal(t, "site-key", body.SiteKey)
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
}

func TestStatusReportsAnEnforcedSite(t *testing.T) {
	recorder := serveStatus(t, stubPolicy{policy: Policy{
		Settings: Settings{
			Enabled:         true,
			Provider:        ProviderHCaptcha,
			SiteKey:         "key",
			OnLogin:         true,
			OnRegister:      true,
			OnPasswordReset: false,
			OnComment:       true,
		},
		SecretConfigured: true,
		Effective:        true,
	}})

	require.Equal(t, http.StatusOK, recorder.Code)
	var body statusResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.True(t, body.Effective)
	require.True(t, body.Scenes["login"])
	require.True(t, body.Scenes["register"])
	require.False(t, body.Scenes["password_reset"])
	require.True(t, body.Scenes["comment"])
	require.Equal(t, "hcaptcha", body.Provider)
}

func TestStatusAnswersServiceUnavailableWhenThePolicyFails(t *testing.T) {
	recorder := serveStatus(t, stubPolicy{err: errors.New("database down")})

	require.Equal(t, http.StatusServiceUnavailable, recorder.Code)
	var problem apperr.Problem
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &problem))
	require.Equal(t, apperr.CodeSecurityUnavailable, problem.Code)
	require.Equal(t, "captcha_policy_unavailable", problem.Details["reason"])
	require.Equal(t, "req-1", problem.RequestID)
}

func TestStatusWithoutAPolicyReadsOff(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	NewHandler(HandlerConfig{}).Routes(engine.Group("/api/v1"))
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/captcha/status", nil))

	require.Equal(t, http.StatusOK, recorder.Code)
	var body statusResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.False(t, body.Effective)
	require.NotEmpty(t, body.Scenes)
	require.Equal(t, string(ProviderTurnstile), body.Provider)
}

// TestProblemKeepsTheStableReasonVocabulary guards the contract detail the SPA
// branches on. A reason that changes silently would break the translated message.
func TestProblemKeepsTheStableReasonVocabulary(t *testing.T) {
	cases := map[error]string{
		ErrTokenMissing:   "captcha_required",
		ErrRejected:       "captcha_invalid",
		ErrReplay:         "captcha_replayed",
		ErrScoreTooLow:    "captcha_score_too_low",
		ErrActionMismatch: "captcha_action_mismatch",
		ErrTimeout:        "captcha_unavailable",
		ErrUpstream:       "captcha_unavailable",
	}
	for err, reason := range cases {
		problem := Problem(err)
		require.NotNil(t, problem)
		require.Equal(t, reason, problem.Details["reason"], err.Error())
	}
	require.Nil(t, Problem(nil))
}

func TestProblemStatuses(t *testing.T) {
	require.Equal(t, http.StatusBadRequest, Problem(ErrTokenMissing).Status)
	require.Equal(t, http.StatusBadRequest, Problem(ErrRejected).Status)
	require.Equal(t, http.StatusServiceUnavailable, Problem(ErrTimeout).Status)
	require.Equal(t, apperr.CodeSecurityUnavailable, Problem(ErrUpstream).Code)
	require.Equal(t, "captcha_token", Problem(ErrRejected).Details["field"])
}
