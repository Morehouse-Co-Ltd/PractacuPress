package sitestore_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/ent/sitecustomization"
	"github.com/practacu/practacu-press/internal/ent/sitemember"
	"github.com/practacu/practacu-press/internal/platformadmin"
	"github.com/practacu/practacu-press/internal/site"
)

func TestCreateSiteWritesSiteAndDefaultDesign(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	created, err := store.CreateSite(ctx, platformadmin.SiteRecord{
		Name:           "Journal",
		Slug:           "journal",
		Description:    "a journal",
		Domain:         "journal.example",
		DomainToken:    "challenge",
		VisibilityMode: site.VisibilityPublic,
		PublishMode:    site.PublishModeReview,
		DesignDocument: []byte(`{"schema_version":2}`),
	})
	require.NoError(t, err)
	require.Equal(t, "journal.example", created.Domain)
	require.False(t, created.DomainVerified())

	design, err := handle.Client.SiteCustomization.Query().
		Where(sitecustomization.SiteIDEQ(created.ID)).
		Only(ctx)
	require.NoError(t, err)
	require.Equal(t, `{"schema_version":2}`, design.Document)
	require.Equal(t, 1, design.Revision)

	taken, err := store.SlugTaken(ctx, "journal")
	require.NoError(t, err)
	require.True(t, taken)
	taken, err = store.DomainTaken(ctx, "journal.example")
	require.NoError(t, err)
	require.True(t, taken)

	listed, err := store.ListSites(ctx, 10)
	require.NoError(t, err)
	require.Len(t, listed, 1)
	require.Equal(t, created.ID, listed[0].ID)
}

func TestEnsureMemberCreatesReactivatesAndCounts(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	created, err := store.CreateSite(ctx, platformadmin.SiteRecord{
		Name: "Journal", Slug: "journal", Domain: "journal.example",
		VisibilityMode: site.VisibilityPublic, PublishMode: site.PublishModeReview,
	})
	require.NoError(t, err)

	audit := site.AuditEntry{
		SiteID:  created.ID,
		ActorID: "root",
		Action:  "platform.site.entered",
		Target:  created.ID,
	}
	require.NoError(t, store.EnsureMember(ctx, created.ID, "root", site.RolePlatformAdmin, audit))

	members, err := store.CountMembers(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, 1, members)
	admins, err := store.CountAdmins(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, 1, admins)

	// A second call updates instead of duplicating.
	require.NoError(t, store.EnsureMember(ctx, created.ID, "root", site.RoleSiteAdmin, audit))
	members, err = store.CountMembers(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, 1, members)

	row, err := handle.Client.SiteMember.Query().
		Where(sitemember.SiteIDEQ(created.ID), sitemember.UserIDEQ("root")).
		Only(ctx)
	require.NoError(t, err)
	require.Equal(t, string(site.RoleSiteAdmin), row.Role)
	require.Equal(t, site.MemberStatusActive, row.Status)
}

func TestDeleteSiteRemovesDesignAndMemberships(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	created, err := store.CreateSite(ctx, platformadmin.SiteRecord{
		Name: "Journal", Slug: "journal", Domain: "journal.example",
		VisibilityMode: site.VisibilityPublic, PublishMode: site.PublishModeReview,
	})
	require.NoError(t, err)
	require.NoError(t, store.EnsureMember(ctx, created.ID, "root", site.RoleSiteAdmin, site.AuditEntry{
		SiteID: created.ID, Action: "platform.site.created", Target: created.ID,
	}))

	require.NoError(t, store.DeleteSite(ctx, created.ID))

	_, err = store.FindSite(ctx, created.ID)
	require.ErrorIs(t, err, site.ErrNotFound)
	customizations, err := handle.Client.SiteCustomization.Query().
		Where(sitecustomization.SiteIDEQ(created.ID)).
		Count(ctx)
	require.NoError(t, err)
	require.Zero(t, customizations)
	members, err := store.CountMembers(ctx, created.ID)
	require.NoError(t, err)
	require.Zero(t, members)
}
