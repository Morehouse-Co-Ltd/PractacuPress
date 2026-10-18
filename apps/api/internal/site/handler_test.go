package site_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	ginrouter "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"

	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
)

type harness struct {
	router *gin.Engine
	db     *db.DB
	siteID string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "site-api.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	cfg := config.Config{AppEnv: config.EnvTest, AuthJWTIssuer: "test-issuer", DefaultSiteID: siteRow.ID}

	issuer, _, err := auth.NewTokenIssuer(cfg)
	require.NoError(t, err)

	authService, err := auth.NewService(auth.ServiceConfig{
		Repository: authstore.New(handle.Client),
		Hasher: auth.NewArgon2idHasher(auth.Argon2Params{
			Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32,
		}),
		Tokens: issuer,
	})
	require.NoError(t, err)

	siteService, err := site.NewService(sitestore.New(handle.Client))
	require.NoError(t, err)

	siteID := siteRow.ID
	authHandler := auth.NewHandler(authService, auth.HandlerConfig{
		SiteID:    func(*gin.Context) string { return siteID },
		Principal: middleware.PrincipalFrom,
	})

	siteHandler := site.NewHandler(siteService, site.HandlerConfig{
		UserID: func(c *gin.Context) (string, bool) {
			principal, ok := middleware.PrincipalFrom(c)
			return principal.UserID, ok
		},
		RequestID: middleware.RequestIDFrom,
	})

	router := ginrouter.New(ginrouter.Dependencies{
		Config:       cfg,
		AccessTokens: issuer,
		Auth:         authHandler,
		Sites:        siteHandler,
	})

	return &harness{router: router, db: handle, siteID: siteRow.ID}
}

func (h *harness) register(t *testing.T, email string) string {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"email": email, "password": "correct horse battery", "display_name": email,
	})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register/email", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	token, _ := payload["access_token"].(string)
	require.NotEmpty(t, token)
	return token
}

func (h *harness) userID(t *testing.T, token string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	user := payload["user"].(map[string]any)
	return user["id"].(string)
}

func (h *harness) setRole(t *testing.T, userID string, role site.Role) {
	t.Helper()
	_, err := h.db.Client.SiteMember.Update().
		Where(sitemember.UserIDEQ(userID)).
		SetRole(string(role)).
		Save(context.Background())
	require.NoError(t, err)
}

func (h *harness) do(t *testing.T, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}

	req := httptest.NewRequest(method, path, reader)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	return w
}

func TestGetSiteReturnsSiteToMember(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "alice@example.com")

	w := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID, token, "")

	require.Equal(t, http.StatusOK, w.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	require.Equal(t, "main", payload["slug"])
	require.Equal(t, "review", payload["publish_mode"])
}

func TestGetSiteRequiresAuthentication(t *testing.T) {
	h := newHarness(t)

	w := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID, "", "")

	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestGetSiteHidesFromNonMember(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "alice@example.com")

	w := h.do(t, http.MethodGet, "/api/v1/sites/does-not-exist", token, "")

	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, "permission_denied", decodeCode(t, w))
}

func TestListMembersRequiresManager(t *testing.T) {
	h := newHarness(t)
	memberToken := h.register(t, "member@example.com")

	forbidden := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID+"/members", memberToken, "")
	require.Equal(t, http.StatusForbidden, forbidden.Code)

	adminToken := h.register(t, "admin@example.com")
	h.setRole(t, h.userID(t, adminToken), site.RoleSiteAdmin)
	// A fresh login carries the new role; tokens are snapshots of the role.
	adminToken = h.login(t, "admin@example.com")

	allowed := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID+"/members", adminToken, "")
	require.Equal(t, http.StatusOK, allowed.Code)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(allowed.Body.Bytes(), &payload))
	items, ok := payload["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 2)
}

func TestChangeMemberRoleSucceedsForAdmin(t *testing.T) {
	h := newHarness(t)

	targetToken := h.register(t, "target@example.com")
	targetID := h.userID(t, targetToken)

	adminToken := h.register(t, "admin@example.com")
	h.setRole(t, h.userID(t, adminToken), site.RoleSiteAdmin)
	adminToken = h.login(t, "admin@example.com")

	w := h.do(t, http.MethodPatch,
		"/api/v1/sites/"+h.siteID+"/members/"+targetID+"/role", adminToken,
		`{"role":"editor"}`)
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())

	// The new role is visible to the target after a fresh login.
	targetToken = h.login(t, "target@example.com")
	me := h.do(t, http.MethodGet, "/api/v1/me", targetToken, "")
	var payload map[string]any
	require.NoError(t, json.Unmarshal(me.Body.Bytes(), &payload))
	require.Equal(t, "editor", payload["role"])
}

func TestChangeMemberRoleRejectsOrdinaryMember(t *testing.T) {
	h := newHarness(t)

	targetID := h.userID(t, h.register(t, "target@example.com"))
	attackerToken := h.register(t, "attacker@example.com")

	w := h.do(t, http.MethodPatch,
		"/api/v1/sites/"+h.siteID+"/members/"+targetID+"/role", attackerToken,
		`{"role":"site_admin"}`)

	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestUpdateSettingsRejectsEditor(t *testing.T) {
	h := newHarness(t)

	editorToken := h.register(t, "editor@example.com")
	h.setRole(t, h.userID(t, editorToken), site.RoleEditor)
	editorToken = h.login(t, "editor@example.com")

	w := h.do(t, http.MethodPatch, "/api/v1/sites/"+h.siteID+"/settings", editorToken,
		`{"publish_mode":"open"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestUpdateSettingsAppliesForAdmin(t *testing.T) {
	h := newHarness(t)

	adminToken := h.register(t, "admin@example.com")
	h.setRole(t, h.userID(t, adminToken), site.RoleSiteAdmin)
	adminToken = h.login(t, "admin@example.com")

	w := h.do(t, http.MethodPatch, "/api/v1/sites/"+h.siteID+"/settings", adminToken,
		`{"publish_mode":"open","visibility_mode":"members_only"}`)
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())

	got := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID, adminToken, "")
	var payload map[string]any
	require.NoError(t, json.Unmarshal(got.Body.Bytes(), &payload))
	require.Equal(t, "open", payload["publish_mode"])
	require.Equal(t, "members_only", payload["visibility_mode"])
}

func (h *harness) login(t *testing.T, email string) string {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"email": email, "password": "correct horse battery",
	})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	token, _ := payload["access_token"].(string)
	require.NotEmpty(t, token)
	return token
}

func decodeCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	code, _ := payload["code"].(string)
	return code
}
