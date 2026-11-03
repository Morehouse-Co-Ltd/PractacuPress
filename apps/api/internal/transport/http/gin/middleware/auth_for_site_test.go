package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// siteEngine builds an engine whose resolved site is fixed, so the guard sees exactly
// the host-to-site mapping a real request would have produced. The verifier is passed
// in so the test signs and verifies with the same key.
func siteEngine(verifier AccessTokenVerifier, resolved site.Site, hasResolved bool) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestID(), ErrorHandler(nil))
	if hasResolved {
		r.Use(func(c *gin.Context) {
			withSite(c, resolved)
			c.Next()
		})
	}
	r.Use(RequireAuthForSite(verifier))
	r.GET("/api/v1/me", func(c *gin.Context) {
		principal, ok := PrincipalFrom(c)
		if !ok {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.JSON(http.StatusOK, gin.H{"user_id": principal.UserID, "site_id": principal.SiteID})
	})
	return r
}

func issueFor(t *testing.T, issuer *auth.TokenIssuer, siteID string) string {
	t.Helper()
	token, _, err := issuer.IssueAccess(auth.Principal{
		UserID: "user_1", SiteID: siteID, Role: site.RoleMember,
	})
	require.NoError(t, err)
	return token
}

// TestRequireAuthForSiteAcceptsTokenForResolvedSite is the positive control: the guard
// must not break the ordinary same-site request.
func TestRequireAuthForSiteAcceptsTokenForResolvedSite(t *testing.T) {
	issuer := testIssuer(t)
	token := issueFor(t, issuer, "site_a")
	engine := siteEngine(issuer, site.Site{ID: "site_a"}, true)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(engine, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.JSONEq(t, `{"user_id":"user_1","site_id":"site_a"}`, w.Body.String())
}

// TestRequireAuthForSiteRejectsCrossSiteToken is the regression test for the tenant
// isolation gap: a token minted for site A must not authenticate a request whose
// hostname resolved to site B.
func TestRequireAuthForSiteRejectsCrossSiteToken(t *testing.T) {
	issuer := testIssuer(t)
	token := issueFor(t, issuer, "site_a")
	engine := siteEngine(issuer, site.Site{ID: "site_b"}, true)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(engine, req)

	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	problem := decodeProblem(t, w.Body.Bytes())
	require.Equal(t, "permission_denied", problem["code"])
	require.Equal(t, "cross_site", problem["details"].(map[string]any)["reason"])
}

// TestRequireAuthForSiteWithoutResolvedSite documents the deliberate fail-open: a
// deployment with no host resolver addresses one fixed site, so there is no tenant to
// cross over to. The alternative - refusing every request - would break the Windows
// single site install, which never resolves a host.
func TestRequireAuthForSiteWithoutResolvedSite(t *testing.T) {
	issuer := testIssuer(t)
	token := issueFor(t, issuer, "site_a")
	engine := siteEngine(issuer, site.Site{}, false)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(engine, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

// TestRequireAuthForSiteStillRejectsMissingToken keeps the composed guard from
// accidentally becoming optional.
func TestRequireAuthForSiteStillRejectsMissingToken(t *testing.T) {
	issuer := testIssuer(t)
	engine := siteEngine(issuer, site.Site{ID: "site_a"}, true)

	w := serve(engine, httptest.NewRequest(http.MethodGet, "/api/v1/me", nil))

	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, "missing_bearer_token",
		decodeProblem(t, w.Body.Bytes())["details"].(map[string]any)["reason"])
}

// TestOptionalAuthDropsForeignSiteToken is the companion fix: an optional-auth route
// must not receive a principal that belongs to another tenant, otherwise the handler
// keys its queries off the wrong site and serves the other tenant's data here.
func TestOptionalAuthDropsForeignSiteToken(t *testing.T) {
	issuer := testIssuer(t)
	foreign := issueFor(t, issuer, "site_a")

	build := func(resolved site.Site, hasResolved bool) *gin.Engine {
		gin.SetMode(gin.TestMode)
		r := gin.New()
		r.Use(RequestID(), ErrorHandler(nil))
		if hasResolved {
			r.Use(func(c *gin.Context) {
				withSite(c, resolved)
				c.Next()
			})
		}
		r.Use(OptionalAuth(issuer))
		r.GET("/x", func(c *gin.Context) {
			principal, ok := PrincipalFrom(c)
			c.JSON(http.StatusOK, gin.H{"authenticated": ok, "site_id": principal.SiteID})
		})
		return r
	}

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+foreign)

	// Matching site: the principal is attached.
	w := serve(build(site.Site{ID: "site_a"}, true), req)
	require.JSONEq(t, `{"authenticated":true,"site_id":"site_a"}`, w.Body.String())

	// Different site: dropped, the request continues anonymously.
	req = httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+foreign)
	w = serve(build(site.Site{ID: "site_b"}, true), req)
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"authenticated":false,"site_id":""}`, w.Body.String())
}

func TestRequireAuthForSiteRejectsInvalidToken(t *testing.T) {
	issuer := testIssuer(t)
	token := issueFor(t, issuer, "site_a")
	engine := siteEngine(issuer, site.Site{ID: "site_a"}, true)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer not.a.token")
	w := serve(engine, req)
	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, "token_invalid",
		decodeProblem(t, w.Body.Bytes())["details"].(map[string]any)["reason"])

	// And the valid one still works.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	require.Equal(t, http.StatusOK, serve(engine, req).Code)
}

// fakeMembershipResolver models the live membership table for the revocation tests.
type fakeMembershipResolver struct {
	member site.Member
	err    error
	calls  int
}

func (f *fakeMembershipResolver) Membership(_ context.Context, siteID, userID string) (site.Member, error) {
	f.calls++
	if f.err != nil {
		return site.Member{}, f.err
	}
	member := f.member
	if member.SiteID == "" {
		member.SiteID = siteID
	}
	if member.UserID == "" {
		member.UserID = userID
	}
	return member, nil
}

// roleEngine mounts RequireAuthForSite with a membership resolver and reports the role
// the handler actually saw.
func roleEngine(verifier AccessTokenVerifier, resolver MembershipResolver, resolved site.Site) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestID(), ErrorHandler(nil))
	r.Use(func(c *gin.Context) {
		withSite(c, resolved)
		c.Next()
	})
	r.Use(RequireAuthForSite(verifier, resolver))
	r.GET("/api/v1/me", func(c *gin.Context) {
		principal, ok := PrincipalFrom(c)
		if !ok {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.JSON(http.StatusOK, gin.H{"role": string(principal.Role), "user_id": principal.UserID})
	})
	return r
}

// TestRequireAuthForSiteUsesLiveRole is the regression test for V-02: a token minted
// while the account was site_admin must stop being treated as site_admin once the
// database says member, without waiting for the token to expire.
func TestRequireAuthForSiteUsesLiveRole(t *testing.T) {
	issuer := testIssuer(t)
	token, _, err := issuer.IssueAccess(auth.Principal{
		UserID: "user_1", SiteID: "site_a", Role: site.RoleSiteAdmin,
	})
	require.NoError(t, err)

	resolver := &fakeMembershipResolver{member: site.Member{
		UserID: "user_1", SiteID: "site_a", Role: site.RoleMember, Status: site.MemberStatusActive,
	}}
	engine := roleEngine(issuer, resolver, site.Site{ID: "site_a"})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(engine, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.JSONEq(t, `{"role":"member","user_id":"user_1"}`, w.Body.String())
	require.Equal(t, 1, resolver.calls, "the guard must consult the membership table")
}

// TestRequireAuthForSiteRejectsInactiveMembership covers suspension and removal: the
// access token stays cryptographically valid, but it must not authenticate any more.
func TestRequireAuthForSiteRejectsInactiveMembership(t *testing.T) {
	issuer := testIssuer(t)
	token := issueFor(t, issuer, "site_a")

	resolver := &fakeMembershipResolver{err: site.ErrMemberNotFound}
	engine := roleEngine(issuer, resolver, site.Site{ID: "site_a"})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(engine, req)

	require.Equal(t, http.StatusUnauthorized, w.Code, w.Body.String())
	problem := decodeProblem(t, w.Body.Bytes())
	require.Equal(t, "membership_inactive", problem["details"].(map[string]any)["reason"])
}

// TestOptionalAuthDropsInactiveMembership keeps public reads working for a suspended
// account without granting it the authenticated view: the request continues anonymously.
func TestOptionalAuthDropsInactiveMembership(t *testing.T) {
	issuer := testIssuer(t)
	token := issueFor(t, issuer, "site_a")

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestID(), ErrorHandler(nil))
	r.Use(func(c *gin.Context) {
		withSite(c, site.Site{ID: "site_a"})
		c.Next()
	})
	r.Use(OptionalAuth(issuer, &fakeMembershipResolver{err: site.ErrMemberNotFound}))
	r.GET("/x", func(c *gin.Context) {
		_, ok := PrincipalFrom(c)
		c.JSON(http.StatusOK, gin.H{"authenticated": ok})
	})

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(r, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.JSONEq(t, `{"authenticated":false}`, w.Body.String())
}
