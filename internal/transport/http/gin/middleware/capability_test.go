package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

// capabilityEngine mounts the capability guard behind site resolution.
func capabilityEngine(verifier AccessTokenVerifier, resolver MembershipResolver) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestID(), ErrorHandler(nil))
	r.Use(func(c *gin.Context) {
		withSite(c, site.Site{ID: "site_a"})
		c.Next()
	})
	r.Use(RequireAuthForSiteWithCapabilities(verifier, resolver))
	r.PATCH("/api/v1/sites/:siteID/settings", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	r.POST("/api/v1/articles", func(c *gin.Context) { c.Status(http.StatusCreated) })
	r.POST("/api/v1/comments", func(c *gin.Context) { c.Status(http.StatusCreated) })
	return r
}

func capabilitySet(enabled ...site.Capability) site.PermissionSet {
	set := site.PermissionSet{}
	for _, capability := range site.AllCapabilities {
		set[capability] = false
	}
	for _, capability := range enabled {
		set[capability] = true
	}
	return set
}

func TestCapabilityGuardRefusesARevokedSiteCapability(t *testing.T) {
	issuer := testIssuer(t)
	token := issueFor(t, issuer, "site_a")
	resolver := &fakeMembershipResolver{member: site.Member{
		Role:        site.RoleSiteAdmin,
		Status:      site.MemberStatusActive,
		Permissions: capabilitySet(site.CapabilityReadContent),
	}}
	engine := capabilityEngine(issuer, resolver)

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/sites/site_a/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(engine, req)

	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	problem := decodeProblem(t, w.Body.Bytes())
	require.Equal(t, "permission_denied", problem["code"])
	details := problem["details"].(map[string]any)
	require.Equal(t, "capability_required", details["reason"])
	require.Equal(t, "manage_site", details["capability"])
}

func TestCapabilityGuardAllowsAnEnabledCapability(t *testing.T) {
	issuer := testIssuer(t)
	token := issueFor(t, issuer, "site_a")
	resolver := &fakeMembershipResolver{member: site.Member{
		Role:        site.RoleSiteAdmin,
		Status:      site.MemberStatusActive,
		Permissions: capabilitySet(site.CapabilityManageSite, site.CapabilityWriteContent),
	}}
	engine := capabilityEngine(issuer, resolver)

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/sites/site_a/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(engine, req)
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
}

func TestCapabilityGuardMapsContentWrites(t *testing.T) {
	issuer := testIssuer(t)
	token := issueFor(t, issuer, "site_a")
	resolver := &fakeMembershipResolver{member: site.Member{
		Role:        site.RoleEditor,
		Status:      site.MemberStatusActive,
		Permissions: capabilitySet(site.CapabilityComment, site.CapabilityModerateContent),
	}}
	engine := capabilityEngine(issuer, resolver)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/articles", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := serve(engine, req)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String(),
		"moderation does not imply content creation")

	// A member-level surface with no capability rule keeps working.
	req = httptest.NewRequest(http.MethodPost, "/api/v1/comments", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w = serve(engine, req)
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
}
