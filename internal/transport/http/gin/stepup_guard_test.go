package ginrouter_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/site"
	ginrouter "github.com/practacu/practacu-press/internal/transport/http/gin"
)

// fakeStepUpEnforcer answers the guard's two questions without a database. Grants
// are keyed by their header value and bound to "user/site", exactly like the real
// signer binds them.
type fakeStepUpEnforcer struct {
	enabled bool
	err     error
	grants  map[string]string
	calls   int
}

// StepUpEnabled implements ginrouter.StepUpEnforcer.
func (f *fakeStepUpEnforcer) StepUpEnabled(context.Context, string) (bool, error) {
	f.calls++
	return f.enabled, f.err
}

// VerifyStepUpToken implements ginrouter.StepUpEnforcer.
func (f *fakeStepUpEnforcer) VerifyStepUpToken(raw, userID, siteID string) bool {
	if f.grants == nil {
		return false
	}
	return f.grants[raw] == userID+"/"+siteID
}

func (f *fakeStepUpEnforcer) grant(userID, siteID string) string {
	if f.grants == nil {
		f.grants = map[string]string{}
	}
	raw := "grant:" + userID + ":" + siteID
	f.grants[raw] = userID + "/" + siteID
	return raw
}

// principalMiddleware puts the principal on the request the same way the real
// authentication guard does. The key is the middleware package's context key.
func principalMiddleware(userID, siteID string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set("practacu.principal", auth.Principal{
			UserID: userID,
			SiteID: siteID,
			Role:   site.RoleSiteAdmin,
		})
		c.Next()
	}
}

// newStepUpEngine mounts one protected route and one benign route.
func newStepUpEngine(enforcer ginrouter.StepUpEnforcer, userID, siteID string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	handler := func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) }
	guard := ginrouter.StepUpGuard(enforcer)

	engine.POST("/api/v1/sites/:siteID/members",
		principalMiddleware(userID, siteID), guard, handler)
	engine.DELETE("/api/v1/sites/:siteID/members/:userID",
		principalMiddleware(userID, siteID), guard, handler)
	engine.PATCH("/api/v1/sites/:siteID/members/:userID/role",
		principalMiddleware(userID, siteID), guard, handler)
	engine.POST("/api/v1/sites/:siteID/members/:userID/2fa/reset",
		principalMiddleware(userID, siteID), guard, handler)
	engine.POST("/api/v1/sites/:siteID/import",
		principalMiddleware(userID, siteID), guard, handler)
	engine.DELETE("/api/v1/sites/:siteID/safety/words/:wordID",
		principalMiddleware(userID, siteID), guard, handler)
	engine.DELETE("/api/v1/sites/:siteID/safety/ip-rules/:ruleID",
		principalMiddleware(userID, siteID), guard, handler)
	// Benign routes that share the module prefixes must not be dragged behind the
	// password prompt.
	engine.PATCH("/api/v1/sites/:siteID/settings",
		principalMiddleware(userID, siteID), guard, handler)
	engine.GET("/api/v1/sites/:siteID/members",
		principalMiddleware(userID, siteID), guard, handler)
	return engine
}

func performStepUpRequest(t *testing.T, engine *gin.Engine, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set(site.StepUpHeaderName, token)
	}
	w := httptest.NewRecorder()
	engine.ServeHTTP(w, req)
	return w
}

func requireStepUpRequired(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, "permission_denied", problemField(t, w, "code"))
	details, ok := problemDetails(t, w)["reason"].(string)
	require.True(t, ok)
	require.Equal(t, "step_up_required", details)
}

func problemDetails(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload struct {
		Details map[string]any `json:"details"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	return payload.Details
}

func problemField(t *testing.T, w *httptest.ResponseRecorder, field string) string {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	value, _ := payload[field].(string)
	return value
}

// TestStepUpGuardDisabledLetsTheProtectedRoutesThrough is the default deployment:
// nothing changes until the site switches the protection on.
func TestStepUpGuardDisabledLetsTheProtectedRoutesThrough(t *testing.T) {
	enforcer := &fakeStepUpEnforcer{enabled: false}
	engine := newStepUpEngine(enforcer, "u1", "s1")

	w := performStepUpRequest(t, engine, http.MethodDelete, "/api/v1/sites/s1/members/u2", "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, 1, enforcer.calls, "the guard must consult the site's switch")
}

// TestStepUpGuardRequiresAGrantWhenEnabled is the core rule: no password proof, no
// high threat operation.
func TestStepUpGuardRequiresAGrantWhenEnabled(t *testing.T) {
	enforcer := &fakeStepUpEnforcer{enabled: true}
	engine := newStepUpEngine(enforcer, "u1", "s1")

	w := performStepUpRequest(t, engine, http.MethodPost, "/api/v1/sites/s1/members", "")
	requireStepUpRequired(t, w)

	// A grant minted for another user or another site is not enough either.
	otherUser := enforcer.grant("u2", "s1")
	requireStepUpRequired(t,
		performStepUpRequest(t, engine, http.MethodPost, "/api/v1/sites/s1/members", otherUser))

	otherSite := enforcer.grant("u1", "s2")
	requireStepUpRequired(t,
		performStepUpRequest(t, engine, http.MethodPost, "/api/v1/sites/s1/members", otherSite))

	// The matching grant authorizes the operation.
	valid := enforcer.grant("u1", "s1")
	allowed := performStepUpRequest(t, engine, http.MethodPost, "/api/v1/sites/s1/members", valid)
	require.Equal(t, http.StatusOK, allowed.Code, allowed.Body.String())
}

// TestStepUpGuardProtectsTheFrozenRouteList pins the routes the contract documents
// as high threat operations. A missing entry would be a silent bypass.
func TestStepUpGuardProtectsTheFrozenRouteList(t *testing.T) {
	enforcer := &fakeStepUpEnforcer{enabled: true}
	engine := newStepUpEngine(enforcer, "u1", "s1")

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/v1/sites/s1/members"},
		{http.MethodDelete, "/api/v1/sites/s1/members/u2"},
		{http.MethodPatch, "/api/v1/sites/s1/members/u2/role"},
		{http.MethodPost, "/api/v1/sites/s1/members/u2/2fa/reset"},
		{http.MethodPost, "/api/v1/sites/s1/import"},
		{http.MethodDelete, "/api/v1/sites/s1/safety/words/w1"},
		{http.MethodDelete, "/api/v1/sites/s1/safety/ip-rules/r1"},
	}
	for _, testCase := range cases {
		w := performStepUpRequest(t, engine, testCase.method, testCase.path, "")
		requireStepUpRequired(t, w)
	}

	// Routes from the same modules that are not on the list stay open.
	for _, testCase := range []struct {
		method string
		path   string
	}{
		{http.MethodPatch, "/api/v1/sites/s1/settings"},
		{http.MethodGet, "/api/v1/sites/s1/members"},
	} {
		w := performStepUpRequest(t, engine, testCase.method, testCase.path, "")
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	}
}

// TestStepUpGuardFailsClosedWhenTheSettingCannotBeRead: a database failure must not
// be mistaken for "protection off".
func TestStepUpGuardFailsClosedWhenTheSettingCannotBeRead(t *testing.T) {
	enforcer := &fakeStepUpEnforcer{enabled: true, err: errors.New("database down")}
	engine := newStepUpEngine(enforcer, "u1", "s1")

	w := performStepUpRequest(t, engine, http.MethodPost, "/api/v1/sites/s1/members", "")
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	require.Equal(t, "internal", problemField(t, w, "code"))
}

// TestStepUpGuardNoOpWithoutAnEnforcer keeps the contract-test router (no services
// wired) and unwired deployments working unchanged.
func TestStepUpGuardNoOpWithoutAnEnforcer(t *testing.T) {
	engine := newStepUpEngine(nil, "u1", "s1")
	w := performStepUpRequest(t, engine, http.MethodPost, "/api/v1/sites/s1/members", "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

func TestStepUpGuardRequiresAPrincipal(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	enforcer := &fakeStepUpEnforcer{enabled: true}
	engine.POST("/api/v1/sites/:siteID/members",
		ginrouter.StepUpGuard(enforcer),
		func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	w := performStepUpRequest(t, engine, http.MethodPost, "/api/v1/sites/s1/members", "")
	require.Equal(t, http.StatusUnauthorized, w.Code, w.Body.String())
	require.False(t, strings.Contains(w.Body.String(), "step_up_required"))
}
