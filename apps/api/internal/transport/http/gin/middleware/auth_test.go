package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

func testIssuer(t *testing.T) *auth.TokenIssuer {
	t.Helper()
	issuer, _, err := auth.NewTokenIssuer(config.Config{
		AppEnv:        config.EnvTest,
		AuthJWTIssuer: "test-issuer",
	})
	require.NoError(t, err)
	return issuer
}

func authEngine(verifier AccessTokenVerifier) *gin.Engine {
	r := newEngine(RequestID(), ErrorHandler(nil), RequireAuth(verifier))
	r.GET("/api/v1/me", func(c *gin.Context) {
		p, ok := PrincipalFrom(c)
		if !ok {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.JSON(http.StatusOK, gin.H{"user_id": p.UserID, "site_id": p.SiteID, "role": string(p.Role)})
	})
	return r
}

func TestRequireAuthAcceptsValidToken(t *testing.T) {
	issuer := testIssuer(t)
	token, _, err := issuer.IssueAccess(auth.Principal{
		UserID: "user_1", SiteID: "site_1", Role: site.RoleEditor,
	})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(authEngine(issuer), req)

	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"user_id":"user_1","site_id":"site_1","role":"editor"}`, w.Body.String())
}

func TestRequireAuthAcceptsLowercaseScheme(t *testing.T) {
	issuer := testIssuer(t)
	token, _, err := issuer.IssueAccess(auth.Principal{
		UserID: "user_1", SiteID: "site_1", Role: site.RoleMember,
	})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "bearer "+token)
	w := serve(authEngine(issuer), req)

	require.Equal(t, http.StatusOK, w.Code)
}

func TestRequireAuthRejectsMissingHeader(t *testing.T) {
	issuer := testIssuer(t)

	w := serve(authEngine(issuer), httptest.NewRequest(http.MethodGet, "/api/v1/me", nil))

	require.Equal(t, http.StatusUnauthorized, w.Code)
	payload := decodeProblem(t, w.Body.Bytes())
	require.Equal(t, "unauthenticated", payload["code"])
	require.Equal(t, "missing_bearer_token", payload["details"].(map[string]any)["reason"])
	require.NotEmpty(t, payload["request_id"])
}

func TestRequireAuthRejectsMalformedHeader(t *testing.T) {
	issuer := testIssuer(t)

	for _, header := range []string{"", "Bearer", "Bearer   ", "Basic abc", "Token abc"} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		w := serve(authEngine(issuer), req)
		require.Equal(t, http.StatusUnauthorized, w.Code, header)
	}
}

func TestRequireAuthRejectsTamperedToken(t *testing.T) {
	issuer := testIssuer(t)
	other := testIssuer(t)

	token, _, err := other.IssueAccess(auth.Principal{
		UserID: "user_1", SiteID: "site_1", Role: site.RoleMember,
	})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(authEngine(issuer), req)

	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, "token_invalid", decodeProblem(t, w.Body.Bytes())["details"].(map[string]any)["reason"])
}

func TestRequireSiteMatchRejectsCrossSiteToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestID(), ErrorHandler(nil))
	r.Use(func(c *gin.Context) {
		withPrincipal(c, auth.Principal{UserID: "user_1", SiteID: "site_a", Role: site.RoleMember})
		withSite(c, site.Site{ID: "site_b"})
		c.Next()
	})
	r.Use(RequireSiteMatch())
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))

	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, "permission_denied", decodeProblem(t, w.Body.Bytes())["code"])
}

func TestRequireSiteMatchAcceptsSameSite(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestID(), ErrorHandler(nil))
	r.Use(func(c *gin.Context) {
		withPrincipal(c, auth.Principal{UserID: "user_1", SiteID: "site_a", Role: site.RoleMember})
		withSite(c, site.Site{ID: "site_a"})
		c.Next()
	})
	r.Use(RequireSiteMatch())
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))

	require.Equal(t, http.StatusOK, w.Code)
}

func TestRequireRoleEnforcesAuthority(t *testing.T) {
	build := func(role site.Role) *gin.Engine {
		r := gin.New()
		r.Use(RequestID(), ErrorHandler(nil))
		r.Use(func(c *gin.Context) {
			withPrincipal(c, auth.Principal{UserID: "u", SiteID: "s", Role: role})
			c.Next()
		})
		r.Use(RequireRole(site.RoleEditor))
		r.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })
		return r
	}

	gin.SetMode(gin.TestMode)
	require.Equal(t, http.StatusOK, serve(build(site.RoleEditor), httptest.NewRequest(http.MethodGet, "/x", nil)).Code)
	require.Equal(t, http.StatusOK, serve(build(site.RoleSiteAdmin), httptest.NewRequest(http.MethodGet, "/x", nil)).Code)
	require.Equal(t, http.StatusForbidden, serve(build(site.RoleMember), httptest.NewRequest(http.MethodGet, "/x", nil)).Code)
}

func TestBearerTokenParsing(t *testing.T) {
	token, ok := bearerToken("Bearer abc.def.ghi")
	require.True(t, ok)
	require.Equal(t, "abc.def.ghi", token)

	for _, bad := range []string{"", "Bearer", "Bearer ", "Basic x", "bearerx y"} {
		_, ok := bearerToken(bad)
		require.False(t, ok, bad)
	}
}

// guard against the verifier interface drifting away from the issuer.
var _ AccessTokenVerifier = (*auth.TokenIssuer)(nil)

// TestOptionalAuthNeverRejects is the property public reads depend on: a missing or
// stale token must not break a page that is readable anonymously.
func TestOptionalAuthNeverRejects(t *testing.T) {
	issuer := testIssuer(t)
	token, _, err := issuer.IssueAccess(auth.Principal{
		UserID: "user_1", SiteID: "site_1", Role: site.RoleMember,
	})
	require.NoError(t, err)

	build := func(header string) *gin.Engine {
		r := gin.New()
		r.Use(RequestID(), ErrorHandler(nil), OptionalAuth(issuer))
		r.GET("/x", func(c *gin.Context) {
			if p, ok := PrincipalFrom(c); ok {
				c.JSON(http.StatusOK, gin.H{"user": p.UserID})
				return
			}
			c.JSON(http.StatusOK, gin.H{"user": ""})
		})
		return r
	}

	// No header: anonymous, still 200.
	require.JSONEq(t, `{"user":""}`, serve(build(""), httptest.NewRequest(http.MethodGet, "/x", nil)).Body.String())

	// Valid token: principal attached.
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	require.JSONEq(t, `{"user":"user_1"}`, serve(build(""), req).Body.String())

	// Garbage token: anonymous, not an error.
	bad := httptest.NewRequest(http.MethodGet, "/x", nil)
	bad.Header.Set("Authorization", "Bearer not-a-token")
	require.Equal(t, http.StatusOK, serve(build(""), bad).Code)
}