package captcha

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// solveLocalQuestion reads the operands out of a challenge question and returns the
// expected answer. The test solves the question the same way a visitor would, which
// is what proves the issued text and the stored answer agree.
func solveLocalQuestion(t *testing.T, question string) int {
	t.Helper()
	var left, right int
	var operation string
	_, err := fmt.Sscanf(question, "%d %s %d = ?", &left, &operation, &right)
	require.NoError(t, err, "question %q is not an arithmetic challenge", question)
	switch operation {
	case "+":
		return left + right
	case "-":
		return left - right
	default:
		t.Fatalf("unknown local challenge operation %q", operation)
		return 0
	}
}

func newLocalTestStore(t *testing.T, options ...func(*LocalStoreConfig)) *LocalStore {
	t.Helper()
	cfg := LocalStoreConfig{}
	for _, option := range options {
		option(&cfg)
	}
	return NewLocalStore(cfg)
}

func TestLocalStoreIssuesAndRedeemsAToken(t *testing.T) {
	store := newLocalTestStore(t)
	verifier := NewVerifier(Config{Local: store})
	require.True(t, verifier.Configured(ProviderLocal), "the local provider needs no secret")
	require.Contains(t, verifier.ConfiguredProviders(), ProviderLocal)

	challenge, err := store.Issue(SceneLogin)
	require.NoError(t, err)
	require.NotEmpty(t, challenge.ID)
	require.Contains(t, challenge.Question, "?")
	require.False(t, challenge.ExpiresAt.IsZero())

	token, expiresAt, err := store.Solve(challenge.ID, solveLocalQuestion(t, challenge.Question), SceneLogin)
	require.NoError(t, err)
	require.NotEmpty(t, token)
	require.True(t, expiresAt.After(time.Now()))

	result, err := verifier.Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    token,
		Scene:    SceneLogin,
	})
	require.NoError(t, err)
	require.Equal(t, ProviderLocal, result.Provider)

	// The token is single use: the second protected request is refused locally.
	_, err = verifier.Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    token,
		Scene:    SceneLogin,
	})
	require.ErrorIs(t, err, ErrReplay)
}

func TestLocalChallengeIsSingleUse(t *testing.T) {
	store := newLocalTestStore(t)
	challenge, err := store.Issue(SceneRegister)
	require.NoError(t, err)
	answer := solveLocalQuestion(t, challenge.Question)

	_, _, err = store.Solve(challenge.ID, answer, SceneRegister)
	require.NoError(t, err)

	// Re-submitting the same challenge must not mint a second token.
	_, _, err = store.Solve(challenge.ID, answer, SceneRegister)
	require.ErrorIs(t, err, ErrRejected)
}

func TestLocalWrongAnswerConsumesTheChallenge(t *testing.T) {
	store := newLocalTestStore(t)
	challenge, err := store.Issue(SceneLogin)
	require.NoError(t, err)
	answer := solveLocalQuestion(t, challenge.Question)

	_, _, err = store.Solve(challenge.ID, answer+1, SceneLogin)
	require.ErrorIs(t, err, ErrRejected)

	// The question was burned by the wrong attempt, so a script cannot probe the
	// two digit answer range on one challenge.
	_, _, err = store.Solve(challenge.ID, answer, SceneLogin)
	require.ErrorIs(t, err, ErrRejected)
}

func TestLocalTokenIsBoundToItsScene(t *testing.T) {
	store := newLocalTestStore(t)
	verifier := NewVerifier(Config{Local: store})
	challenge, err := store.Issue(SceneLogin)
	require.NoError(t, err)
	token, _, err := store.Solve(challenge.ID, solveLocalQuestion(t, challenge.Question), SceneLogin)
	require.NoError(t, err)

	_, err = verifier.Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    token,
		Scene:    SceneRegister,
	})
	require.ErrorIs(t, err, ErrActionMismatch)

	// A token offered to the wrong form is not burned, so the correct form can still
	// spend it: the failure is a form bug, not a solved challenge.
	_, err = verifier.Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    token,
		Scene:    SceneLogin,
	})
	require.NoError(t, err)
}

func TestLocalChallengesAndTokensExpire(t *testing.T) {
	now := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	store := newLocalTestStore(t, func(cfg *LocalStoreConfig) {
		cfg.Now = func() time.Time { return now }
		cfg.ChallengeTTL = time.Minute
		cfg.TokenTTL = 5 * time.Minute
	})

	challenge, err := store.Issue(SceneLogin)
	require.NoError(t, err)
	now = now.Add(2 * time.Minute)
	_, _, err = store.Solve(challenge.ID, solveLocalQuestion(t, challenge.Question), SceneLogin)
	require.ErrorIs(t, err, ErrRejected, "an expired question must be refused")

	fresh, err := store.Issue(SceneLogin)
	require.NoError(t, err)
	token, _, err := store.Solve(fresh.ID, solveLocalQuestion(t, fresh.Question), SceneLogin)
	require.NoError(t, err)
	now = now.Add(6 * time.Minute)
	_, err = NewVerifier(Config{Local: store}).Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    token,
		Scene:    SceneLogin,
	})
	require.ErrorIs(t, err, ErrRejected, "an expired token must be refused")
}

func TestLocalRedeemRequiresAnIssuedToken(t *testing.T) {
	store := newLocalTestStore(t)
	verifier := NewVerifier(Config{Local: store})

	_, err := verifier.Verify(context.Background(), Request{Provider: ProviderLocal, Token: "  "})
	require.ErrorIs(t, err, ErrTokenMissing)

	_, err = verifier.Verify(context.Background(), Request{Provider: ProviderLocal, Token: "made-up", Scene: SceneLogin})
	require.ErrorIs(t, err, ErrRejected)
}

func TestLocalProviderWithoutAStoreIsNotConfigured(t *testing.T) {
	verifier := NewVerifier(Config{})
	require.False(t, verifier.Configured(ProviderLocal))
	_, err := verifier.Verify(context.Background(), Request{Provider: ProviderLocal, Token: "x"})
	require.ErrorIs(t, err, ErrNotConfigured)
}

// localEngine mounts the captcha handler with the same problem middleware the real
// router installs, so the assertions are on the HTTP answer a browser gets.
func localEngine(t *testing.T, store *LocalStore) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(gin.CustomRecovery(func(c *gin.Context, _ any) {
		c.Status(http.StatusInternalServerError)
	}))
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
	NewHandler(HandlerConfig{
		Local:     store,
		RequestID: func(*gin.Context) string { return "req-local" },
	}).Routes(engine.Group("/api/v1"))
	return engine
}

type localChallengeBody struct {
	ChallengeID string    `json:"challenge_id"`
	Question    string    `json:"question"`
	ExpiresAt   time.Time `json:"expires_at"`
}

func getLocalChallenge(t *testing.T, engine *gin.Engine, scene string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/api/v1/captcha/local/challenge?scene="+scene, nil,
	))
	return recorder
}

func postLocalVerify(t *testing.T, engine *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/captcha/local/verify", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, request)
	return recorder
}

func TestLocalEndpointsIssueAndSolveAChallenge(t *testing.T) {
	store := newLocalTestStore(t)
	engine := localEngine(t, store)

	recorder := getLocalChallenge(t, engine, "login")
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
	var challenge localChallengeBody
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &challenge))
	require.NotEmpty(t, challenge.ChallengeID)
	require.Contains(t, challenge.Question, "?")

	answer := solveLocalQuestion(t, challenge.Question)
	payload, err := json.Marshal(map[string]any{
		"challenge_id": challenge.ChallengeID,
		"answer":       answer,
		"scene":        "login",
	})
	require.NoError(t, err)

	solved := postLocalVerify(t, engine, string(payload))
	require.Equal(t, http.StatusOK, solved.Code)
	var solvedBody struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	require.NoError(t, json.Unmarshal(solved.Body.Bytes(), &solvedBody))
	require.NotEmpty(t, solvedBody.Token)
	require.False(t, solvedBody.ExpiresAt.IsZero())

	// The token the endpoint returned is exactly what the protected handler's
	// verifier path accepts.
	_, err = NewVerifier(Config{Local: store}).Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    solvedBody.Token,
		Scene:    SceneLogin,
	})
	require.NoError(t, err)
}

func TestLocalVerifyRefusesAWrongAnswer(t *testing.T) {
	store := newLocalTestStore(t)
	engine := localEngine(t, store)
	challengeRecorder := getLocalChallenge(t, engine, "login")
	var challenge localChallengeBody
	require.NoError(t, json.Unmarshal(challengeRecorder.Body.Bytes(), &challenge))

	answer := solveLocalQuestion(t, challenge.Question) + 1
	payload, err := json.Marshal(map[string]any{
		"challenge_id": challenge.ChallengeID,
		"answer":       answer,
		"scene":        "login",
	})
	require.NoError(t, err)

	recorder := postLocalVerify(t, engine, string(payload))
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	var problem apperr.Problem
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &problem))
	require.Equal(t, apperr.CodeValidationFailed, problem.Code)
	require.Equal(t, "captcha_invalid", problem.Details["reason"])
	require.Equal(t, "req-local", problem.RequestID)
}

func TestLocalEndpointsValidateTheirInput(t *testing.T) {
	engine := localEngine(t, newLocalTestStore(t))

	missingScene := getLocalChallenge(t, engine, "")
	require.Equal(t, http.StatusBadRequest, missingScene.Code)

	unknownScene := getLocalChallenge(t, engine, "mystery")
	require.Equal(t, http.StatusBadRequest, unknownScene.Code)

	missingBody := postLocalVerify(t, engine, `{}`)
	require.Equal(t, http.StatusBadRequest, missingBody.Code)

	malformed := postLocalVerify(t, engine, `not json`)
	require.Equal(t, http.StatusBadRequest, malformed.Code)
}

func TestLocalEndpointsAnswerUnavailableWithoutAStore(t *testing.T) {
	engine := localEngine(t, nil)

	for _, recorder := range []*httptest.ResponseRecorder{
		getLocalChallenge(t, engine, "login"),
		postLocalVerify(t, engine, `{"challenge_id":"x","answer":1,"scene":"login"}`),
	} {
		require.Equal(t, http.StatusServiceUnavailable, recorder.Code)
		var problem apperr.Problem
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &problem))
		require.Equal(t, apperr.CodeSecurityUnavailable, problem.Code)
		require.Equal(t, "captcha_unavailable", problem.Details["reason"])
	}
}

// TestGuardEnforcesTheLocalProvider is the end-to-end local path through the guard:
// the site selected the local provider without a site key, the process wires the
// store, and a protected request must present a token the store issued.
func TestGuardEnforcesTheLocalProvider(t *testing.T) {
	store := newLocalTestStore(t)
	document := []byte(`{"verification":{"enabled":true,"provider":"local",` +
		`"site_key":"","on_login":true,"on_register":true}}`)
	guard := NewGuard(GuardConfig{
		Verifier:      NewVerifier(Config{Local: store}),
		Customization: func(context.Context, string) ([]byte, error) { return document, nil },
	})

	policy, err := guard.Policy(context.Background(), "site")
	require.NoError(t, err)
	require.True(t, policy.SecretConfigured)
	require.True(t, policy.Effective, "the local provider needs no site key or secret")
	require.True(t, policy.SceneEnforced(SceneLogin))

	// Without a token the protected request is refused and never reaches a provider.
	err = guard.Require(context.Background(), RequireInput{SiteID: "site", Scene: SceneLogin})
	require.ErrorIs(t, err, ErrTokenMissing)

	challenge, err := store.Issue(SceneLogin)
	require.NoError(t, err)
	token, _, err := store.Solve(challenge.ID, solveLocalQuestion(t, challenge.Question), SceneLogin)
	require.NoError(t, err)
	require.NoError(t, guard.Require(context.Background(), RequireInput{
		SiteID: "site", Scene: SceneLogin, Token: token,
	}))
}
