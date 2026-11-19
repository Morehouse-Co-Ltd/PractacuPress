package site

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The wizard resets the browser's saved install configuration on these answers, so
// each of them has to say exactly one thing and nothing more.

func TestInstallStatusReportsNoSiteForAnUnknownHost(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)

	status, err := service.InstallStatus(context.Background(), "localhost")

	require.NoError(t, err)
	require.False(t, status.Installed)
	require.Equal(t, InstallReasonNoSite, status.Reason)
	require.Empty(t, status.SiteID)
	require.False(t, status.HasAdmin)
}

func TestInstallStatusReportsTheResolvedSingleSite(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "site_main", Name: "Practacu Press", Slug: "main"}}
	repo.members[memberKey("site_main", "usr_owner")] = activeMember("site_main", "usr_owner", RoleSiteAdmin)
	service := newService(t, repo)

	status, err := service.InstallStatus(context.Background(), "localhost:8080")

	require.NoError(t, err)
	require.True(t, status.Installed)
	require.Empty(t, status.Reason)
	require.Equal(t, "site_main", status.SiteID)
	require.Equal(t, "Practacu Press", status.SiteName)
	require.True(t, status.HasAdmin)
}

func TestInstallStatusCountsOnlyActiveAdministrators(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{ID: "site_main", Name: "Practacu Press"}}
	// A member, an editor and a suspended administrator all leave the site without
	// anyone able to finish the wizard's remaining steps.
	repo.members[memberKey("site_main", "usr_member")] = activeMember("site_main", "usr_member", RoleMember)
	repo.members[memberKey("site_main", "usr_editor")] = activeMember("site_main", "usr_editor", RoleEditor)
	suspended := activeMember("site_main", "usr_admin", RoleSiteAdmin)
	suspended.Status = MemberStatusSuspended
	repo.members[memberKey("site_main", "usr_admin")] = suspended
	service := newService(t, repo)

	status, err := service.InstallStatus(context.Background(), "localhost")

	require.NoError(t, err)
	require.True(t, status.Installed)
	require.False(t, status.HasAdmin)
}

func TestInstallStatusKeepsUnverifiedDomainsApartFromNoSite(t *testing.T) {
	// The site exists, so reinstalling would not help. Reporting "no site" here
	// would make the wizard wipe a configuration that still describes the server.
	repo := newFakeRepo()
	repo.sites = []Site{{
		ID:        "site_main",
		Name:      "Practacu Press",
		Domain:    "press.example.com",
		CreatedAt: time.Now().UTC(),
	}}
	service := newService(t, repo)

	status, err := service.InstallStatus(context.Background(), "press.example.com")

	require.NoError(t, err)
	require.False(t, status.Installed)
	require.Equal(t, InstallReasonDomainUnverified, status.Reason)
	require.Empty(t, status.SiteID)
}

func TestInstallStatusRejectsAHostOwnedByAnotherSite(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []Site{{
		ID:               "site_main",
		Name:             "Practacu Press",
		Domain:           "press.example.com",
		DomainVerifiedAt: ptrTime(time.Now().UTC()),
	}}
	service := newService(t, repo)

	status, err := service.InstallStatus(context.Background(), "other.example.com")

	require.NoError(t, err)
	require.False(t, status.Installed)
	require.Equal(t, InstallReasonNoSite, status.Reason)
}

func ptrTime(value time.Time) *time.Time { return &value }
