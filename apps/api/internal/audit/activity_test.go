package audit_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	ginmiddleware "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// member builds one active membership with an explicit capability matrix.
func member(role site.Role, permissions site.PermissionSet) site.Member {
	return site.Member{
		UserID:      "u1",
		SiteID:      "s1",
		Role:        role,
		Status:      site.MemberStatusActive,
		Permissions: permissions,
	}
}

// TestActivityAuthorisesViewLog proves the projection is gated by the view_log
// capability, not by site administration: an editor with the capability may read
// it and a site administrator with it revoked may not.
func TestActivityAuthorisesViewLog(t *testing.T) {
	repo := &fakeRepo{items: []audit.Log{{ID: "log-1", Action: "content.publish"}}}
	service, err := audit.NewService(repo)
	require.NoError(t, err)

	items, err := service.Activity(context.Background(), admin(), "s1", 20)
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "s1", repo.gotFilter.SiteID)

	// An editor with the capability enabled by a custom group may read the panel.
	withViewLog := site.PermissionSet{site.CapabilityViewLog: true}
	_, err = service.Activity(context.Background(), member(site.RoleEditor, withViewLog), "s1", 20)
	require.NoError(t, err)

	// A site administrator whose matrix revoked view_log may not.
	revoked := site.DefaultCapabilities(site.RoleSiteAdmin)
	revoked[site.CapabilityViewLog] = false
	_, err = service.Activity(context.Background(), member(site.RoleSiteAdmin, revoked), "s1", 20)
	require.ErrorIs(t, err, audit.ErrPermissionDenied)

	// The path may not name another site.
	_, err = service.Activity(context.Background(), admin(), "s2", 20)
	require.ErrorIs(t, err, audit.ErrPermissionDenied)
}

// TestActivityLimitDefaultsAndClamps keeps the panel request bounded.
func TestActivityLimitDefaultsAndClamps(t *testing.T) {
	repo := &fakeRepo{}
	service, err := audit.NewService(repo)
	require.NoError(t, err)

	_, err = service.Activity(context.Background(), admin(), "s1", 0)
	require.NoError(t, err)
	require.Equal(t, audit.ActivityDefaultLimit, repo.gotLimit)

	_, err = service.Activity(context.Background(), admin(), "s1", 7)
	require.NoError(t, err)
	require.Equal(t, 7, repo.gotLimit)

	_, err = service.Activity(context.Background(), admin(), "s1", 1000)
	require.NoError(t, err)
	require.Equal(t, audit.ActivityDefaultLimit, repo.gotLimit)
}

// activityEngine mounts the audit routes the way the router does.
func activityEngine(t *testing.T, service *audit.Service) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	// The error translator turns an aborted handler into the problem response, so a
	// validation failure is observed as its HTTP status like in production.
	engine.Use(ginmiddleware.ErrorHandler(nil))
	handler := audit.NewHandler(service, audit.HandlerConfig{
		Principal: func(c *gin.Context) (site.Member, bool) {
			return site.Member{
				UserID: "u1",
				SiteID: "s1",
				Role:   site.RoleSiteAdmin,
				Status: site.MemberStatusActive,
			}, true
		},
	})
	noop := func(c *gin.Context) { c.Next() }
	handler.Routes(engine.Group("/api/v1"), noop)
	return engine
}

// TestActivityResponseShape freezes the SiteActivityItem contract fields.
func TestActivityResponseShape(t *testing.T) {
	createdAt := time.Date(2026, 11, 17, 8, 30, 0, 0, time.UTC)
	repo := &fakeRepo{items: []audit.Log{{
		ID:         "log-1",
		SiteID:     "s1",
		ActorID:    "u2",
		ActorName:  "Alice",
		Action:     "content.publish",
		TargetType: "content",
		TargetID:   "c1",
		Outcome:    "success",
		Detail:     map[string]any{"summary": "Published “Hello”"},
		CreatedAt:  createdAt,
	}}}
	service, err := audit.NewService(repo)
	require.NoError(t, err)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/s1/activity?limit=10", nil)
	response := httptest.NewRecorder()
	activityEngine(t, service).ServeHTTP(response, request)

	require.Equal(t, http.StatusOK, response.Code)
	var body struct {
		Items []struct {
			ID         string    `json:"id"`
			Action     string    `json:"action"`
			ActorID    string    `json:"actor_id"`
			ActorName  string    `json:"actor_name"`
			TargetType string    `json:"target_type"`
			TargetID   string    `json:"target_id"`
			Outcome    string    `json:"outcome"`
			Detail     string    `json:"detail"`
			CreatedAt  time.Time `json:"created_at"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Len(t, body.Items, 1)
	item := body.Items[0]
	require.Equal(t, "log-1", item.ID)
	require.Equal(t, "content.publish", item.Action)
	require.Equal(t, "Alice", item.ActorName, "the actor name is joined by the repository")
	require.Equal(t, "content", item.TargetType)
	require.Equal(t, "c1", item.TargetID)
	require.Equal(t, "success", item.Outcome)
	require.Equal(t, "Published “Hello”", item.Detail)
	require.True(t, createdAt.Equal(item.CreatedAt))
	require.Equal(t, 10, repo.gotLimit)
}

// TestActivityRejectsAMalformedLimit keeps a client bug a 400, not a full page.
func TestActivityRejectsAMalformedLimit(t *testing.T) {
	service, err := audit.NewService(&fakeRepo{})
	require.NoError(t, err)

	for _, raw := range []string{"limit=0", "limit=abc", "limit=101"} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/s1/activity?"+raw, nil)
		response := httptest.NewRecorder()
		activityEngine(t, service).ServeHTTP(response, request)
		require.Equal(t, http.StatusBadRequest, response.Code, raw)
	}
}

// TestActivityDetailRendersMapsAsAString proves the contract's string type holds
// even when the audit row carries a structured detail.
func TestActivityDetailRendersMapsAsAString(t *testing.T) {
	repo := &fakeRepo{items: []audit.Log{{
		ID:        "log-1",
		Action:    "content.update",
		Outcome:   "success",
		Detail:    map[string]any{"from": "draft", "to": "published"},
		CreatedAt: time.Now().UTC(),
	}}}
	service, err := audit.NewService(repo)
	require.NoError(t, err)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/s1/activity", nil)
	response := httptest.NewRecorder()
	activityEngine(t, service).ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code)

	var body struct {
		Items []struct {
			Detail string `json:"detail"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Len(t, body.Items, 1)
	require.Contains(t, body.Items[0].Detail, `"from":"draft"`)
	require.Contains(t, body.Items[0].Detail, `"to":"published"`)
}
