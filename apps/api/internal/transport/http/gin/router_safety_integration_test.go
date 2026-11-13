package ginrouter_test

// This file is the SQLite smoke test for the content safety feature. It wires the
// real Ent stores, the real safety/community services and real Gin handlers against a
// throwaway SQLite database, then drives HTTP requests end to end. It proves the
// three server side promises in one place: a sensitive word rejects a comment, an
// exceeded frequency window answers 429 with Retry-After, and a site IP rule answers
// 403 / lets a whitelisted address through.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/community"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/communitystore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/safetystore"
	"github.com/practacu/practacu-press/apps/api/internal/safety"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

const safetySmokeSiteID = "site_smoke"
const safetySmokeUserID = "user_smoke"

type smokeSiteResolver struct{}

func (smokeSiteResolver) Resolve(context.Context, string) (site.Site, error) {
	return site.Site{ID: safetySmokeSiteID, Name: "Smoke", Slug: "smoke"}, nil
}

func TestContentSafetySQLiteSmoke(t *testing.T) {
	ctx := context.Background()
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "safety-smoke.db")))
	require.NoError(t, err)
	defer func() { require.NoError(t, handle.Close()) }()
	require.NoError(t, handle.Client.Schema.Create(ctx))

	safetyService, err := safety.NewService(safetystore.New(handle.Client))
	require.NoError(t, err)

	communityService, err := community.NewService(
		communitystore.New(handle.Client),
		communitystore.New(handle.Client),
		community.WithCommentGuard(safetyService),
	)
	require.NoError(t, err)

	engine := newSmokeEngine(t, safetyService, communityService)
	admin := safety.Actor{UserID: safetySmokeUserID, SiteID: safetySmokeSiteID, Role: site.RoleSiteAdmin}

	// Frequency window: one signed-in comment per minute. This runs first so the
	// window counters start clean; the window is widened afterwards for the word-list
	// cases so a previous count cannot mask them.
	userLimit, ipLimit, window := 1, 0, 60
	_, err = safetyService.UpdateRateLimit(ctx, admin, safetySmokeSiteID, safety.RateLimitInput{
		UserLimit: &userLimit, IPLimit: &ipLimit, WindowSeconds: &window,
	})
	require.NoError(t, err)
	require.Equal(t, http.StatusCreated, postComment(t, engine, "203.0.113.10:1234", "first").Code)
	limited := postComment(t, engine, "203.0.113.10:1234", "second")
	require.Equal(t, http.StatusTooManyRequests, limited.Code)
	retryAfter, err := strconv.Atoi(limited.Header().Get("Retry-After"))
	require.NoError(t, err)
	require.GreaterOrEqual(t, retryAfter, 1)
	limitedProblem := decodeProblem(t, limited)
	require.Equal(t, "rate_limited", limitedProblem.Code)
	require.Equal(t, "user", limitedProblem.Details["scope"])
	require.EqualValues(t, retryAfter, limitedProblem.Details["retry_after_seconds"])

	// Widen the window so the word-list cases below are not refused by the limiter.
	widened, noIPLimit := 100, 0
	_, err = safetyService.UpdateRateLimit(ctx, admin, safetySmokeSiteID, safety.RateLimitInput{
		UserLimit: &widened, IPLimit: &noIPLimit, WindowSeconds: &window,
	})
	require.NoError(t, err)

	// A reject word refuses the write with problem+json 403 reason sensitive_word.
	_, err = safetyService.CreateWord(ctx, admin, safetySmokeSiteID, safety.WordInput{
		Word: "forbid", Mode: safety.ModeReject,
	})
	require.NoError(t, err)
	response := postComment(t, engine, "203.0.113.10:1234", "this is FORBID")
	require.Equal(t, http.StatusForbidden, response.Code)
	problem := decodeProblem(t, response)
	require.Equal(t, "permission_denied", problem.Code)
	require.Equal(t, "sensitive_word", problem.Details["reason"])

	// A replace word rewrites the stored body, and a review word queues it.
	_, err = safetyService.CreateWord(ctx, admin, safetySmokeSiteID, safety.WordInput{
		Word: "badword", Mode: safety.ModeReplace, Replacement: "***",
	})
	require.NoError(t, err)
	created := postComment(t, engine, "203.0.113.10:1234", "a BadWord here")
	require.Equal(t, http.StatusCreated, created.Code)
	var commentBody struct {
		Body   string `json:"body"`
		Status string `json:"status"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &commentBody))
	require.Equal(t, "a *** here", commentBody.Body)
	require.Equal(t, community.CommentStatusVisible, commentBody.Status)

	_, err = safetyService.CreateWord(ctx, admin, safetySmokeSiteID, safety.WordInput{
		Word: "queue", Mode: safety.ModeReview,
	})
	require.NoError(t, err)
	queued := postComment(t, engine, "203.0.113.10:1234", "please queue me")
	require.Equal(t, http.StatusCreated, queued.Code)
	require.NoError(t, json.Unmarshal(queued.Body.Bytes(), &commentBody))
	require.Equal(t, community.CommentStatusPending, commentBody.Status)

	// A deny rule refuses the address on every route of the host-resolved site.
	_, err = safetyService.CreateIPRule(ctx, admin, safetySmokeSiteID, safety.IPRuleInput{
		Kind: safety.IPRuleDeny, Value: "198.51.100.7",
	})
	require.NoError(t, err)
	blocked := getComments(t, engine, "198.51.100.7:1234")
	require.Equal(t, http.StatusForbidden, blocked.Code)
	require.Equal(t, "ip_blocked", decodeProblem(t, blocked).Details["reason"])

	// A non-empty allow list restricts the site, while a listed address passes.
	_, err = safetyService.CreateIPRule(ctx, admin, safetySmokeSiteID, safety.IPRuleInput{
		Kind: safety.IPRuleAllow, Value: "203.0.113.0/24",
	})
	require.NoError(t, err)
	unlisted := getComments(t, engine, "192.0.2.44:1234")
	require.Equal(t, http.StatusForbidden, unlisted.Code)
	require.Equal(t, "ip_blocked", decodeProblem(t, unlisted).Details["reason"])

	allowed := getComments(t, engine, "203.0.113.55:1234")
	require.Equal(t, http.StatusOK, allowed.Code)

	// Loopback stays reachable so the operator can always fix the list.
	loopback := getComments(t, engine, "127.0.0.1:1234")
	require.Equal(t, http.StatusOK, loopback.Code)

	// The admin endpoints are wired through the same host-resolved chain: list the
	// policy, then create and delete one word over HTTP.
	policyResponse := serveSmoke(
		engine, http.MethodGet, "/api/v1/sites/"+safetySmokeSiteID+"/safety",
		"203.0.113.55:1234", nil,
	)
	require.Equal(t, http.StatusOK, policyResponse.Code)
	var policyBody struct {
		RateLimit struct {
			UserPerWindow int `json:"user_per_window"`
			IPPerWindow   int `json:"ip_per_window"`
			WindowSeconds int `json:"window_seconds"`
		} `json:"rate_limit"`
		Words   []map[string]any `json:"words"`
		IPRules []map[string]any `json:"ip_rules"`
	}
	require.NoError(t, json.Unmarshal(policyResponse.Body.Bytes(), &policyBody))
	require.Equal(t, 100, policyBody.RateLimit.UserPerWindow)
	require.NotEmpty(t, policyBody.Words)
	require.Len(t, policyBody.IPRules, 2)

	wordPayload, err := json.Marshal(map[string]any{"word": "smoke-only", "mode": "review"})
	require.NoError(t, err)
	wordResponse := serveSmoke(
		engine, http.MethodPost, "/api/v1/sites/"+safetySmokeSiteID+"/safety/words",
		"203.0.113.55:1234", wordPayload,
	)
	require.Equal(t, http.StatusCreated, wordResponse.Code)
	var createdWord struct {
		ID   string `json:"id"`
		Word string `json:"word"`
		Mode string `json:"mode"`
	}
	require.NoError(t, json.Unmarshal(wordResponse.Body.Bytes(), &createdWord))
	require.Equal(t, "smoke-only", createdWord.Word)
	require.Equal(t, "review", createdWord.Mode)

	deleted := serveSmoke(
		engine, http.MethodDelete,
		"/api/v1/sites/"+safetySmokeSiteID+"/safety/words/"+createdWord.ID,
		"203.0.113.55:1234", nil,
	)
	require.Equal(t, http.StatusNoContent, deleted.Code)

	// The hit is auditable: the comment audit row names the matched word and action.
	entries, err := handle.Client.AuditLog.Query().All(ctx)
	require.NoError(t, err)
	found := false
	for _, entry := range entries {
		if entry.Action != "community.comment.created" || entry.Detail == nil {
			continue
		}
		raw, marshalErr := json.Marshal(entry.Detail)
		require.NoError(t, marshalErr)
		if bytes.Contains(raw, []byte("content_safety")) &&
			bytes.Contains(raw, []byte("badword")) &&
			bytes.Contains(raw, []byte("replace")) {
			found = true
		}
	}
	require.True(t, found, "a sensitive-word hit must be visible in the audit detail")
}

// newSmokeEngine mounts the community and safety handlers on the same site-resolved
// chain the production router uses.
func newSmokeEngine(
	t *testing.T,
	safetyService *safety.Service,
	communityService *community.Service,
) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	engine := gin.New()
	engine.Use(
		middleware.RequestID(),
		middleware.Recovery(logger),
		middleware.ErrorHandler(logger),
	)

	trusted, err := middleware.NewTrustedProxies(nil)
	require.NoError(t, err)

	v1 := engine.Group("/api/v1")
	v1.Use(middleware.ResolveSite(trusted, smokeSiteResolver{}))
	v1.Use(middleware.SiteIPGuard(safetyService))

	passThrough := func(c *gin.Context) { c.Next() }

	communityHandler := community.NewHandler(communityService, community.HandlerConfig{
		Principal: func(c *gin.Context) (community.Actor, bool) {
			return community.Actor{
				UserID: safetySmokeUserID,
				SiteID: safetySmokeSiteID,
				Role:   site.RoleMember,
				IP:     c.ClientIP(),
			}, true
		},
		Site: middleware.SiteFrom,
	})
	communityHandler.Routes(v1, passThrough, passThrough)

	safetyHandler := safety.NewHandler(safetyService, safety.HandlerConfig{
		Principal: func(c *gin.Context) (safety.Actor, bool) {
			return safety.Actor{
				UserID: safetySmokeUserID,
				SiteID: safetySmokeSiteID,
				Role:   site.RoleSiteAdmin,
			}, true
		},
	})
	safetyHandler.Routes(v1, passThrough)

	return engine
}

func postComment(t *testing.T, engine *gin.Engine, remoteAddr, body string) *httptest.ResponseRecorder {
	t.Helper()
	payload := map[string]any{
		"target_type": "article",
		"target_id":   "article_smoke",
		"body":        body,
	}
	raw, err := json.Marshal(payload)
	require.NoError(t, err)
	return serveSmoke(engine, http.MethodPost, "/api/v1/comments", remoteAddr, raw)
}

func getComments(t *testing.T, engine *gin.Engine, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()
	return serveSmoke(engine, http.MethodGet, "/api/v1/comments", remoteAddr, nil)
}

func serveSmoke(
	engine *gin.Engine,
	method, target, remoteAddr string,
	body []byte,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	request.Host = "smoke.test"
	request.RemoteAddr = remoteAddr
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	return recorder
}

type smokeProblem struct {
	Code    string         `json:"code"`
	Status  int            `json:"status"`
	Details map[string]any `json:"details"`
}

func decodeProblem(t *testing.T, rec *httptest.ResponseRecorder) smokeProblem {
	t.Helper()
	require.Contains(t, rec.Header().Get("Content-Type"), "application/problem+json")
	var problem smokeProblem
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &problem))
	require.Equal(t, rec.Code, problem.Status)
	return problem
}
