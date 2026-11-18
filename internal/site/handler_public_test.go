package site_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/sitemember"
	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/site"
)

// get performs one request against the harness router with an optional bearer token.
func (h *harness) get(t *testing.T, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	return w
}

// memberOf returns the single membership of the harness site.
func (h *harness) memberOf(t *testing.T) *entgen.SiteMember {
	t.Helper()
	row, err := h.db.Client.SiteMember.Query().
		Where(sitemember.SiteIDEQ(h.siteID)).
		Only(context.Background())
	require.NoError(t, err)
	return row
}

// TestPublicProfileOnMembersOnlySiteRequiresThisSitesMembership is the regression test
// for the tenant gap in the public author profile: the route is public on a public site
// and gated on a members-only one, and the gate must be "member of *this* site", not
// "presented some valid session".
func TestPublicProfileOnMembersOnlySiteRequiresThisSitesMembership(t *testing.T) {
	h := newHarnessWithVisibility(t, site.VisibilityMembersOnly)
	token := h.register(t, "reader@example.com")
	member := h.memberOf(t)
	path := "/api/v1/users/" + member.UserID

	// An active member of the site may read the directory.
	require.Equal(t, http.StatusOK, h.get(t, path, token).Code)

	// Suspending the membership takes the same token out of the gate: an account that
	// is no longer a member must not keep a closed directory readable.
	_, err := h.db.Client.SiteMember.UpdateOneID(member.ID).
		SetStatus(site.MemberStatusSuspended).
		Save(context.Background())
	require.NoError(t, err)

	require.Equal(t, http.StatusUnauthorized, h.get(t, path, token).Code)
}

// TestPublicProfileAllowsAnonymousReaderOnPublicSite keeps the public behaviour intact.
func TestPublicProfileAllowsAnonymousReaderOnPublicSite(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "reader@example.com")
	member := h.memberOf(t)
	path := "/api/v1/users/" + member.UserID

	require.Equal(t, http.StatusOK, h.get(t, path, "").Code)
	require.Equal(t, http.StatusOK, h.get(t, path, token).Code)
}

// TestCrossSiteTokenCannotReadAnotherSitesMemberDirectory is the end-to-end version of
// the finding: a token minted for another site carries no authority here. OptionalAuth
// drops it (it describes a different tenant), so the request is judged as an anonymous
// reader and a members-only site refuses it instead of handing over its directory.
func TestCrossSiteTokenCannotReadAnotherSitesMemberDirectory(t *testing.T) {
	h := newHarnessWithVisibility(t, site.VisibilityMembersOnly)
	_ = h.register(t, "reader@example.com")
	member := h.memberOf(t)

	foreign, _, err := h.issuer.IssueAccess(auth.Principal{
		UserID: "outsider", SiteID: "site_other", Role: site.RolePlatformAdmin,
	})
	require.NoError(t, err)

	w := h.get(t, "/api/v1/users/"+member.UserID, foreign)

	require.Equal(t, http.StatusUnauthorized, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "members_only_site",
		"the directory must not be readable through a token from another site")
}

// TestCrossSiteTokenDoesNotUnlockPublicReads keeps the anonymous path honest: on a
// public site the foreign token is ignored rather than honoured, so the reader gets
// this site's anonymous view instead of the other tenant's view.
func TestCrossSiteTokenDoesNotUnlockPublicReads(t *testing.T) {
	h := newHarness(t)
	_ = h.register(t, "reader@example.com")
	member := h.memberOf(t)

	foreign, _, err := h.issuer.IssueAccess(auth.Principal{
		UserID: "outsider", SiteID: "site_other", Role: site.RolePlatformAdmin,
	})
	require.NoError(t, err)

	// The public profile stays readable, and it describes the host-resolved site's
	// member - the foreign principal contributed nothing.
	w := h.get(t, "/api/v1/users/"+member.UserID, foreign)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), member.UserID)
}
