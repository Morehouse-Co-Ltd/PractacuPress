package analyticsstore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/analytics"
	"github.com/practacu/practacu-press/internal/infrastructure/analyticsstore"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/site"
)

func TestReportAgainstSQLite(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 34, 56, 0, time.UTC)

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "analytics.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	mainSite, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)
	otherSite, err := handle.Client.Site.Create().SetSlug("other").SetName("Other").Save(ctx)
	require.NoError(t, err)

	store := analyticsstore.New(handle.Client)
	visits := []analytics.Visit{
		{SiteID: mainSite.ID, Path: "/a/cnt_1", Session: "s1", Surface: analytics.SurfaceSite, CreatedAt: now.Add(-10 * time.Minute)},
		{SiteID: mainSite.ID, Path: "/a/cnt_1", Session: "s1", Surface: analytics.SurfaceSite, CreatedAt: now.Add(-2 * time.Minute)},
		{SiteID: mainSite.ID, Path: "/", Session: "s2", Surface: analytics.SurfaceSite, CreatedAt: now.Add(-time.Hour)},
		{SiteID: mainSite.ID, Path: "/p/pst_1", Session: "s3", Surface: analytics.SurfaceSite, CreatedAt: now.Add(-2 * time.Hour)},
		// Outside the 24h window.
		{SiteID: mainSite.ID, Path: "/a/cnt_old", Session: "s4", Surface: analytics.SurfaceSite, CreatedAt: now.Add(-26 * time.Hour)},
		// Admin traffic is recorded but never reported.
		{SiteID: mainSite.ID, Path: "/admin", Session: "s5", Surface: analytics.SurfaceAdmin, CreatedAt: now.Add(-time.Minute)},
		// Another tenant is never counted.
		{SiteID: otherSite.ID, Path: "/a/foreign", Session: "s6", Surface: analytics.SurfaceSite, CreatedAt: now.Add(-time.Minute)},
	}
	for _, visit := range visits {
		require.NoError(t, store.Insert(ctx, visit))
	}

	service, err := analytics.NewService(analytics.ServiceConfig{
		Repository: store,
		Now:        func() time.Time { return now },
	})
	require.NoError(t, err)

	report, err := service.Report(ctx, analytics.Actor{
		UserID: "admin", SiteID: mainSite.ID, Role: site.RoleSiteAdmin,
	}, mainSite.ID, analytics.Range24h)
	require.NoError(t, err)

	require.Equal(t, analytics.Totals{Views: 4, Sessions: 3, Online: 1}, report.Totals)
	require.Len(t, report.Series, 24)
	seriesSum := 0
	for _, point := range report.Series {
		seriesSum += point.Count
	}
	require.Equal(t, 4, seriesSum)

	// The most recent view is in the last bucket: the current, partial hour.
	require.Equal(t, 2, report.Series[23].Count)
	require.Equal(t, "12:00", report.Series[23].Label)

	require.Equal(t, []analytics.TopPage{
		{Path: "/a/cnt_1", Count: 2},
		{Path: "/", Count: 1},
		{Path: "/p/pst_1", Count: 1},
	}, report.TopPages)
	require.Equal(t, []analytics.TopContent{
		{ID: "cnt_1", Count: 2},
		{ID: "pst_1", Count: 1},
	}, report.TopContent)
}
