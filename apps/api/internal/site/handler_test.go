package site_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/notificationstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/apps/api/internal/notifications"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	ginrouter "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"

	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
)

type harness struct {
	router      *gin.Engine
	db          *db.DB
	siteID      string
	issuer      *auth.TokenIssuer
	siteService *site.Service
}

// staticSiteResolver always resolves to the single test site, which is how the
// visibility mode reaches the public profile endpoint.
type staticSiteResolver struct{ site site.Site }

func (s staticSiteResolver) Resolve(context.Context, string) (site.Site, error) { return s.site, nil }

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWithVisibility(t, site.VisibilityPublic)
}

func newHarnessWithVisibility(t *testing.T, visibility site.VisibilityMode) *harness {
	t.Helper()
	return newHarnessWithOptions(t, visibility, nil)
}

// newHarnessWithTXT lets a test drive the DNS challenge without touching real DNS.
func newHarnessWithTXT(t *testing.T, lookup site.TXTLookup) *harness {
	t.Helper()
	return newHarnessWithOptions(t, site.VisibilityPublic, lookup)
}

func newHarnessWithOptions(t *testing.T, visibility site.VisibilityMode, lookup site.TXTLookup) *harness {
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

	var siteOptions []site.Option
	if lookup != nil {
		siteOptions = append(siteOptions, site.WithTXTLookup(lookup))
	}
	siteService, err := site.NewService(sitestore.New(handle.Client), siteOptions...)
	require.NoError(t, err)

	siteID := siteRow.ID
	authHandler := auth.NewHandler(authService, auth.HandlerConfig{
		SiteID:    func(*gin.Context) string { return siteID },
		Principal: middleware.PrincipalFrom,
	})

	// The contact form goes through the real notification store: the endpoint's whole
	// job is to write one inbox row per administrator, so a fake would test nothing.
	notificationService, err := notifications.NewService(notificationstore.New(handle.Client))
	require.NoError(t, err)
	contactService, err := site.NewContactService(site.ContactConfig{
		Repository: sitestore.New(handle.Client),
		Notifier:   notificationService,
	})
	require.NoError(t, err)

	siteHandler := site.NewHandler(siteService, site.HandlerConfig{
		Principal: func(c *gin.Context) (string, string, bool) {
			principal, ok := middleware.PrincipalFrom(c)
			return principal.UserID, principal.SiteID, ok
		},
		Site:      middleware.SiteFrom,
		RequestID: middleware.RequestIDFrom,
		Contact:   contactService,
	})

	router := ginrouter.New(ginrouter.Dependencies{
		Config:       cfg,
		SiteResolver: staticSiteResolver{site: site.Site{ID: siteID, Slug: "main", Name: "Main", VisibilityMode: visibility}},
		AccessTokens: issuer,
		Auth:         authHandler,
		Sites:        siteHandler,
	})

	return &harness{router: router, db: handle, siteID: siteRow.ID, issuer: issuer, siteService: siteService}
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

func (h *harness) attemptLogin(t *testing.T, email string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"email": email, "password": "correct horse battery",
	})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	return w
}

func (h *harness) login(t *testing.T, email string) string {
	t.Helper()
	w := h.attemptLogin(t, email)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	token, _ := payload["access_token"].(string)
	require.NotEmpty(t, token)
	return token
}

// makePlatformAdmin registers an account and promotes it to platform administrator.
func (h *harness) makePlatformAdmin(t *testing.T, email string) (token, userID string) {
	t.Helper()
	token = h.register(t, email)
	userID = h.userID(t, token)
	h.setRole(t, userID, site.RolePlatformAdmin)
	return h.login(t, email), userID
}

// makeSiteAdmin registers an account and promotes it to site administrator.
func (h *harness) makeSiteAdmin(t *testing.T, email string) (token, userID string) {
	t.Helper()
	token = h.register(t, email)
	userID = h.userID(t, token)
	h.setRole(t, userID, site.RoleSiteAdmin)
	return h.login(t, email), userID
}

// mintToken issues an access token for an arbitrary site, which is how the tests
// exercise the cross site guard without a second site in the database.
func (h *harness) mintToken(t *testing.T, userID, siteID string, role site.Role) string {
	t.Helper()
	token, _, err := h.issuer.IssueAccess(auth.Principal{UserID: userID, SiteID: siteID, Role: role})
	require.NoError(t, err)
	return token
}

// decodeMember decodes a Member body.
func decodeMember(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	return payload
}

// decodeReason returns details.reason of a Problem body.
func decodeReason(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	details, _ := payload["details"].(map[string]any)
	reason, _ := details["reason"].(string)
	return reason
}

func decodeCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	code, _ := payload["code"].(string)
	return code
}

// --- member administration -------------------------------------------------

func (h *harness) memberPath(userID, suffix string) string {
	return "/api/v1/sites/" + h.siteID + "/members/" + userID + suffix
}

func TestListMembersReturnsEmailAndStatus(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makePlatformAdmin(t, "root@example.com")
	targetID := h.userID(t, h.register(t, "member@example.com"))

	w := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID+"/members", adminToken, "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	items, ok := payload["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 2)

	var target map[string]any
	for _, item := range items {
		row := item.(map[string]any)
		if row["user_id"] == targetID {
			target = row
		}
	}
	require.NotNil(t, target, "the ordinary member must be in the list")
	require.Equal(t, "member@example.com", target["email"])
	require.Equal(t, "active", target["status"])
	require.Equal(t, "member", target["role"])
}

func TestUpdateMemberProfileChangesNameAndLoginEmail(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makePlatformAdmin(t, "root@example.com")
	targetID := h.userID(t, h.register(t, "target@example.com"))

	w := h.do(t, http.MethodPatch, h.memberPath(targetID, ""), adminToken,
		`{"display_name":"Target Renamed","email":"new@example.com"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	member := decodeMember(t, w)
	require.Equal(t, targetID, member["user_id"])
	require.Equal(t, "Target Renamed", member["display_name"])
	require.Equal(t, "new@example.com", member["email"])
	require.Equal(t, "active", member["status"])

	// The login identity moved with the profile: the old address stops working and
	// the new one starts working.
	require.Equal(t, http.StatusUnauthorized, h.attemptLogin(t, "target@example.com").Code)
	require.NotEmpty(t, h.login(t, "new@example.com"))
}

func TestUpdateMemberProfileRejectsDuplicateEmail(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makePlatformAdmin(t, "root@example.com")
	targetID := h.userID(t, h.register(t, "target@example.com"))

	w := h.do(t, http.MethodPatch, h.memberPath(targetID, ""), adminToken,
		`{"email":"root@example.com"}`)
	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	require.Equal(t, "conflict", decodeCode(t, w))
	require.Equal(t, "email_taken", decodeReason(t, w))
}

func TestUpdateMemberProfileRejectsSiteAdminSelfAndPlatformPeers(t *testing.T) {
	h := newHarness(t)
	rootToken, rootID := h.makePlatformAdmin(t, "root@example.com")
	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")
	targetID := h.userID(t, h.register(t, "target@example.com"))

	// A site administrator may manage members but not rewrite an account.
	w := h.do(t, http.MethodPatch, h.memberPath(targetID, ""), adminToken, `{"display_name":"x"}`)
	require.Equal(t, http.StatusForbidden, w.Code)

	// Nobody edits its own account here.
	w = h.do(t, http.MethodPatch, h.memberPath(rootID, ""), rootToken, `{"display_name":"x"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, "self_management", decodeReason(t, w))

	// Nor another platform administrator.
	peerToken, peerID := h.makePlatformAdmin(t, "peer@example.com")
	w = h.do(t, http.MethodPatch, h.memberPath(peerID, ""), rootToken, `{"display_name":"x"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, "target_role_not_lower", decodeReason(t, w))

	require.NotEmpty(t, peerToken)
}

func TestUpdateMemberProfileUnknownTargetIsNotFound(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makePlatformAdmin(t, "root@example.com")

	w := h.do(t, http.MethodPatch, h.memberPath("usr_ghost", ""), adminToken, `{"display_name":"x"}`)

	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.Equal(t, "not_found", decodeCode(t, w))
}

func TestSuspendMemberBlocksLoginAndReactivationRestoresIt(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makePlatformAdmin(t, "root@example.com")
	targetID := h.userID(t, h.register(t, "target@example.com"))

	w := h.do(t, http.MethodPatch, h.memberPath(targetID, "/status"), adminToken, `{"status":"suspended"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "suspended", decodeMember(t, w)["status"])

	// A suspended membership cannot start a session.
	denied := h.attemptLogin(t, "target@example.com")
	require.Equal(t, http.StatusForbidden, denied.Code, denied.Body.String())

	// It is still listed, so an administrator can find and reactivate it.
	list := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID+"/members", adminToken, "")
	require.Equal(t, http.StatusOK, list.Code)
	require.Contains(t, list.Body.String(), `"suspended"`)

	w = h.do(t, http.MethodPatch, h.memberPath(targetID, "/status"), adminToken, `{"status":"active"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "active", decodeMember(t, w)["status"])
	require.NotEmpty(t, h.login(t, "target@example.com"))
}

func TestUpdateMemberStatusRejectsBadRequestsAndSiteAdmins(t *testing.T) {
	h := newHarness(t)
	rootToken, rootID := h.makePlatformAdmin(t, "root@example.com")
	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")
	targetID := h.userID(t, h.register(t, "target@example.com"))

	w := h.do(t, http.MethodPatch, h.memberPath(targetID, "/status"), adminToken, `{"status":"suspended"}`)
	require.Equal(t, http.StatusForbidden, w.Code)

	w = h.do(t, http.MethodPatch, h.memberPath(targetID, "/status"), rootToken, `{"status":"invited"}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, "validation_failed", decodeCode(t, w))

	w = h.do(t, http.MethodPatch, h.memberPath(rootID, "/status"), rootToken, `{"status":"suspended"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, "self_management", decodeReason(t, w))
}

func TestDeleteMemberRemovesMembershipButKeepsAccount(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makePlatformAdmin(t, "root@example.com")
	targetID := h.userID(t, h.register(t, "target@example.com"))

	w := h.do(t, http.MethodDelete, h.memberPath(targetID, ""), adminToken, "")
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())

	// The membership is gone, so the account can no longer authenticate here. The
	// account row itself survives, which is why this is a refusal rather than a
	// credential failure.
	denied := h.attemptLogin(t, "target@example.com")
	require.Equal(t, http.StatusForbidden, denied.Code, denied.Body.String())

	list := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID+"/members", adminToken, "")
	var payload map[string]any
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &payload))
	require.Len(t, payload["items"].([]any), 1)

	// Deleting twice is a not found, not a silent success.
	again := h.do(t, http.MethodDelete, h.memberPath(targetID, ""), adminToken, "")
	require.Equal(t, http.StatusNotFound, again.Code)
}

func TestDeleteMemberRejectsSiteAdminAndSelf(t *testing.T) {
	h := newHarness(t)
	rootToken, rootID := h.makePlatformAdmin(t, "root@example.com")
	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")
	targetID := h.userID(t, h.register(t, "target@example.com"))

	w := h.do(t, http.MethodDelete, h.memberPath(targetID, ""), adminToken, "")
	require.Equal(t, http.StatusForbidden, w.Code)

	w = h.do(t, http.MethodDelete, h.memberPath(rootID, ""), rootToken, "")
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, "self_management", decodeReason(t, w))
}

func TestChangeMemberRoleRejectsDemotingLastPlatformAdmin(t *testing.T) {
	h := newHarness(t)
	adminToken, adminID := h.makePlatformAdmin(t, "root@example.com")

	w := h.do(t, http.MethodPatch, h.memberPath(adminID, "/role"), adminToken, `{"role":"member"}`)

	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, "last_platform_admin", decodeReason(t, w))
}

func TestMemberAdministrationRejectsTokenFromAnotherSite(t *testing.T) {
	h := newHarness(t)
	_, adminID := h.makePlatformAdmin(t, "root@example.com")
	crossToken := h.mintToken(t, adminID, "another-site", site.RolePlatformAdmin)
	targetID := h.userID(t, h.register(t, "target@example.com"))

	w := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID+"/members", crossToken, "")
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, "cross_site", decodeReason(t, w))

	w = h.do(t, http.MethodDelete, h.memberPath(targetID, ""), crossToken, "")
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, "cross_site", decodeReason(t, w))
}

// --- public author profile -------------------------------------------------

func TestPublicUserProfileIsPublicOnPublicSite(t *testing.T) {
	h := newHarness(t)
	userID := h.userID(t, h.register(t, "alice@example.com"))

	w := h.do(t, http.MethodGet, "/api/v1/users/"+userID, "", "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	payload := decodeMember(t, w)
	require.Equal(t, userID, payload["user_id"])
	require.Equal(t, "alice@example.com", payload["display_name"])
	require.Equal(t, "member", payload["role"])

	createdAt, ok := payload["created_at"].(string)
	require.True(t, ok, "created_at must be an RFC3339 timestamp")
	_, err := time.Parse(time.RFC3339Nano, createdAt)
	require.NoError(t, err)
	require.NotContains(t, w.Body.String(), "email", "the public profile must not expose the login email")
}

func TestPublicUserProfileUnknownMemberIsNotFound(t *testing.T) {
	h := newHarness(t)

	w := h.do(t, http.MethodGet, "/api/v1/users/usr_ghost", "", "")

	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.Equal(t, "not_found", decodeCode(t, w))
}

func TestPublicUserProfileHidesSuspendedMember(t *testing.T) {
	h := newHarness(t)
	targetID := h.userID(t, h.register(t, "target@example.com"))
	adminToken, _ := h.makePlatformAdmin(t, "root@example.com")

	suspended := h.do(t, http.MethodPatch, h.memberPath(targetID, "/status"), adminToken, `{"status":"suspended"}`)
	require.Equal(t, http.StatusOK, suspended.Code, suspended.Body.String())

	w := h.do(t, http.MethodGet, "/api/v1/users/"+targetID, "", "")
	require.Equal(t, http.StatusNotFound, w.Code, "a suspended member is not a public author")
}

func TestPublicUserProfileOnMembersOnlySiteRequiresSession(t *testing.T) {
	h := newHarnessWithVisibility(t, site.VisibilityMembersOnly)
	token := h.register(t, "alice@example.com")
	userID := h.userID(t, token)

	anonymous := h.do(t, http.MethodGet, "/api/v1/users/"+userID, "", "")
	require.Equal(t, http.StatusUnauthorized, anonymous.Code, anonymous.Body.String())
	require.Equal(t, "unauthenticated", decodeCode(t, anonymous))

	authenticated := h.do(t, http.MethodGet, "/api/v1/users/"+userID, token, "")
	require.Equal(t, http.StatusOK, authenticated.Code, authenticated.Body.String())
}

// --- primary domain --------------------------------------------------------

// fakeTXTLookup is an injectable DNS resolver for the handler level challenge tests.
type fakeTXTLookup struct {
	records map[string][]string
	err     error
}

func (f *fakeTXTLookup) LookupTXT(_ context.Context, name string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.records[name], nil
}

func TestUpdateDomainStartsUnverifiedChallenge(t *testing.T) {
	lookup := &fakeTXTLookup{records: map[string][]string{}}
	h := newHarnessWithTXT(t, lookup)
	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")

	w := h.do(t, http.MethodPut, "/api/v1/sites/"+h.siteID+"/domain", adminToken,
		`{"domain":"Press.Example.com."}`)
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())

	row, err := h.db.Client.Site.Get(context.Background(), h.siteID)
	require.NoError(t, err)
	require.NotNil(t, row.Domain)
	require.Equal(t, "press.example.com", *row.Domain)
	require.Nil(t, row.DomainVerifiedAt, "declaring a domain must not verify it")
	require.NotNil(t, row.DomainVerificationToken, "declaring a domain must mint a challenge token")
	require.NotEmpty(t, *row.DomainVerificationToken)

	// The declared host does not serve until the challenge passes; the operator's own
	// loopback host keeps working so the admin UI stays reachable.
	_, err = h.siteService.Resolve(context.Background(), "press.example.com")
	require.ErrorIs(t, err, site.ErrDomainUnverified)
	_, err = h.siteService.Resolve(context.Background(), "127.0.0.1")
	require.NoError(t, err)

	// The site payload exposes the verification state to the admin UI.
	got := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID, adminToken, "")
	require.Equal(t, http.StatusOK, got.Code)
	var sitePayload map[string]any
	require.NoError(t, json.Unmarshal(got.Body.Bytes(), &sitePayload))
	require.Equal(t, false, sitePayload["domain_verified"])

	// GET /domain returns the exact record the operator has to publish.
	domain := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID+"/domain", adminToken, "")
	require.Equal(t, http.StatusOK, domain.Code, domain.Body.String())
	var domainPayload map[string]any
	require.NoError(t, json.Unmarshal(domain.Body.Bytes(), &domainPayload))
	require.Equal(t, "press.example.com", domainPayload["domain"])
	require.Equal(t, false, domainPayload["verified"])
	require.Equal(t, *row.DomainVerificationToken, domainPayload["verification_token"])
	require.Equal(t, "_practacu-verify.press.example.com", domainPayload["record_name"])
	require.Equal(t, "TXT", domainPayload["record_type"])
}

func TestDomainVerificationFlow(t *testing.T) {
	lookup := &fakeTXTLookup{records: map[string][]string{}}
	h := newHarnessWithTXT(t, lookup)
	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")
	path := "/api/v1/sites/" + h.siteID

	put := h.do(t, http.MethodPut, path+"/domain", adminToken, `{"domain":"press.example.com"}`)
	require.Equal(t, http.StatusNoContent, put.Code, put.Body.String())

	row, err := h.db.Client.Site.Get(context.Background(), h.siteID)
	require.NoError(t, err)
	token := *row.DomainVerificationToken
	recordName := "_practacu-verify.press.example.com"

	// A wrong record is a conflict with a machine readable reason, and changes nothing.
	lookup.records[recordName] = []string{"not-the-token"}
	failed := h.do(t, http.MethodPost, path+"/domain/verify", adminToken, "")
	require.Equal(t, http.StatusConflict, failed.Code, failed.Body.String())
	require.Equal(t, "conflict", decodeCode(t, failed))
	require.Equal(t, "domain_verification_failed", decodeReason(t, failed))

	row, err = h.db.Client.Site.Get(context.Background(), h.siteID)
	require.NoError(t, err)
	require.Nil(t, row.DomainVerifiedAt, "a failed challenge must not verify")

	// The published record proves ownership; any matching value counts.
	lookup.records[recordName] = []string{"unrelated", " " + token + " "}
	verified := h.do(t, http.MethodPost, path+"/domain/verify", adminToken, "")
	require.Equal(t, http.StatusOK, verified.Code, verified.Body.String())
	var payload map[string]any
	require.NoError(t, json.Unmarshal(verified.Body.Bytes(), &payload))
	require.Equal(t, true, payload["verified"])
	require.Equal(t, "", payload["verification_token"], "a verified domain has nothing left to prove")
	require.Equal(t, recordName, payload["record_name"])
	require.Equal(t, "TXT", payload["record_type"])

	row, err = h.db.Client.Site.Get(context.Background(), h.siteID)
	require.NoError(t, err)
	require.NotNil(t, row.DomainVerifiedAt)

	resolved, err := h.siteService.Resolve(context.Background(), "press.example.com")
	require.NoError(t, err, "the verified domain starts serving")
	require.Equal(t, h.siteID, resolved.ID)

	// A second verification is idempotent.
	again := h.do(t, http.MethodPost, path+"/domain/verify", adminToken, "")
	require.Equal(t, http.StatusOK, again.Code, again.Body.String())

	// The site payload now reports the domain as verified.
	got := h.do(t, http.MethodGet, path, adminToken, "")
	var sitePayload map[string]any
	require.NoError(t, json.Unmarshal(got.Body.Bytes(), &sitePayload))
	require.Equal(t, true, sitePayload["domain_verified"])
}

func TestGetDomainWithoutDomainIsEmpty(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")

	domain := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID+"/domain", adminToken, "")
	require.Equal(t, http.StatusOK, domain.Code, domain.Body.String())

	var payload map[string]any
	require.NoError(t, json.Unmarshal(domain.Body.Bytes(), &payload))
	require.Equal(t, "", payload["domain"])
	require.Equal(t, false, payload["verified"])
	require.Equal(t, "", payload["verification_token"])
	require.Equal(t, "", payload["record_name"])
	require.Equal(t, "TXT", payload["record_type"])

	// Verifying without a domain is a validation failure.
	verify := h.do(t, http.MethodPost, "/api/v1/sites/"+h.siteID+"/domain/verify", adminToken, "")
	require.Equal(t, http.StatusBadRequest, verify.Code)
	require.Equal(t, "validation_failed", decodeCode(t, verify))
}

func TestDomainEndpointsRequireManager(t *testing.T) {
	h := newHarness(t)
	memberToken := h.register(t, "member@example.com")

	editorToken := h.register(t, "editor@example.com")
	h.setRole(t, h.userID(t, editorToken), site.RoleEditor)
	editorToken = h.login(t, "editor@example.com")

	path := "/api/v1/sites/" + h.siteID + "/domain"

	require.Equal(t, http.StatusUnauthorized, h.do(t, http.MethodGet, path, "", "").Code)
	require.Equal(t, http.StatusUnauthorized, h.do(t, http.MethodPost, path+"/verify", "", "").Code)
	require.Equal(t, http.StatusForbidden, h.do(t, http.MethodGet, path, memberToken, "").Code)
	require.Equal(t, http.StatusForbidden, h.do(t, http.MethodPost, path+"/verify", memberToken, "").Code)
	require.Equal(t, http.StatusForbidden, h.do(t, http.MethodGet, path, editorToken, "").Code)

	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")
	require.Equal(t, http.StatusOK, h.do(t, http.MethodGet, path, adminToken, "").Code)
}

func TestUpdateDomainClearsDomainAndRestoresFallback(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")

	first := h.do(t, http.MethodPut, "/api/v1/sites/"+h.siteID+"/domain", adminToken,
		`{"domain":"press.example.com"}`)
	require.Equal(t, http.StatusNoContent, first.Code, first.Body.String())

	pending, err := h.db.Client.Site.Get(context.Background(), h.siteID)
	require.NoError(t, err)
	require.NotNil(t, pending.DomainVerificationToken)

	clear := h.do(t, http.MethodPut, "/api/v1/sites/"+h.siteID+"/domain", adminToken, `{"domain":""}`)
	require.Equal(t, http.StatusNoContent, clear.Code, clear.Body.String())

	row, err := h.db.Client.Site.Get(context.Background(), h.siteID)
	require.NoError(t, err)
	require.True(t, row.Domain == nil || *row.Domain == "")
	require.Nil(t, row.DomainVerifiedAt)
	require.Nil(t, row.DomainVerificationToken, "clearing a domain must drop the challenge token")

	// A single site without a domain answers through the fallback again.
	resolved, err := h.siteService.Resolve(context.Background(), "127.0.0.1")
	require.NoError(t, err)
	require.Equal(t, h.siteID, resolved.ID)
}

func TestUpdateDomainRejectsInvalidDomains(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")
	path := "/api/v1/sites/" + h.siteID + "/domain"

	invalidBodies := []string{
		`{"domain":"https://press.example.com"}`,
		`{"domain":"press.example.com/path"}`,
		`{"domain":"press.example.com:8080"}`,
		`{"domain":"*.example.com"}`,
		`{"domain":"127.0.0.1"}`,
		`{"domain":"press example.com"}`,
		`{}`,
		`not-json`,
	}
	for _, body := range invalidBodies {
		w := h.do(t, http.MethodPut, path, adminToken, body)
		require.Equal(t, http.StatusBadRequest, w.Code, body)
		require.Equal(t, "validation_failed", decodeCode(t, w), body)
	}

	row, err := h.db.Client.Site.Get(context.Background(), h.siteID)
	require.NoError(t, err)
	require.True(t, row.Domain == nil, "a rejected domain must not be stored")
}

func TestUpdateDomainRejectsNonAdministrators(t *testing.T) {
	h := newHarness(t)
	memberToken := h.register(t, "member@example.com")

	editorToken := h.register(t, "editor@example.com")
	h.setRole(t, h.userID(t, editorToken), site.RoleEditor)
	editorToken = h.login(t, "editor@example.com")

	path := "/api/v1/sites/" + h.siteID + "/domain"

	anonymous := h.do(t, http.MethodPut, path, "", `{"domain":"press.example.com"}`)
	require.Equal(t, http.StatusUnauthorized, anonymous.Code)

	denied := h.do(t, http.MethodPut, path, memberToken, `{"domain":"press.example.com"}`)
	require.Equal(t, http.StatusForbidden, denied.Code)

	denied = h.do(t, http.MethodPut, path, editorToken, `{"domain":"press.example.com"}`)
	require.Equal(t, http.StatusForbidden, denied.Code)
}

func TestUpdateDomainRejectsDomainOfAnotherSite(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")

	_, err := h.db.Client.Site.Create().
		SetSlug("other").SetName("Other").
		SetDomain("taken.example.com").
		SetDomainVerifiedAt(time.Now().UTC()).
		Save(context.Background())
	require.NoError(t, err)

	w := h.do(t, http.MethodPut, "/api/v1/sites/"+h.siteID+"/domain", adminToken,
		`{"domain":"taken.example.com"}`)

	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	require.Equal(t, "domain_taken", decodeReason(t, w))
}

// --- registration switch (O-3 site half) -----------------------------------

func TestGetSiteExposesRegistrationOpen(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "member@example.com")

	w := h.do(t, http.MethodGet, "/api/v1/sites/"+h.siteID, token, "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	require.Equal(t, true, payload["registration_open"], "new sites allow sign-ups by default")
}

func TestUpdateSettingsRegistrationSwitch(t *testing.T) {
	h := newHarness(t)
	adminToken, _ := h.makeSiteAdmin(t, "admin@example.com")
	path := "/api/v1/sites/" + h.siteID + "/settings"

	closed := h.do(t, http.MethodPatch, path, adminToken, `{"registration_open":false}`)
	require.Equal(t, http.StatusNoContent, closed.Code, closed.Body.String())

	row, err := h.db.Client.Site.Get(context.Background(), h.siteID)
	require.NoError(t, err)
	require.False(t, row.RegistrationOpen)

	// A patch that omits the field must not reopen it.
	other := h.do(t, http.MethodPatch, path, adminToken, `{"publish_mode":"open"}`)
	require.Equal(t, http.StatusNoContent, other.Code, other.Body.String())
	row, err = h.db.Client.Site.Get(context.Background(), h.siteID)
	require.NoError(t, err)
	require.False(t, row.RegistrationOpen, "an omitted field must not change the switch")

	reopened := h.do(t, http.MethodPatch, path, adminToken, `{"registration_open":true}`)
	require.Equal(t, http.StatusNoContent, reopened.Code, reopened.Body.String())
	row, err = h.db.Client.Site.Get(context.Background(), h.siteID)
	require.NoError(t, err)
	require.True(t, row.RegistrationOpen)

	// Only managers may flip the switch.
	memberToken := h.register(t, "member2@example.com")
	denied := h.do(t, http.MethodPatch, path, memberToken, `{"registration_open":false}`)
	require.Equal(t, http.StatusForbidden, denied.Code)
}
