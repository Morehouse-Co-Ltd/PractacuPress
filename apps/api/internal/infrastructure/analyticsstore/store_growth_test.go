package analyticsstore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/analytics"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/analyticsstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// TestGrowthAggregatesAgainstSQLite exercises the source/device/referrer/retention
// queries end to end. It runs on SQLite because that is in-process, but the queries
// use only portable ent operations (GROUP BY on plain columns and MIN(created_at)),
// so they behave the same on MySQL and PostgreSQL.
func TestGrowthAggregatesAgainstSQLite(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "analytics-growth.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	mainSite, err := handle.Client.Site.Create().SetSlug("growth-main").SetName("Growth Main").Save(ctx)
	require.NoError(t, err)
	otherSite, err := handle.Client.Site.Create().SetSlug("growth-other").SetName("Growth Other").Save(ctx)
	require.NoError(t, err)

	store := analyticsstore.New(handle.Client)
	visits := []analytics.Visit{
		// Before the 7d window: this is what makes s_old a returning session.
		{
			SiteID: mainSite.ID, Path: "/a/old", Session: "s_old", Surface: analytics.SurfaceSite,
			ReferrerHost: "www.google.com", Source: analytics.SourceSearch, Device: analytics.DeviceMobile,
			CreatedAt: time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC),
		},
		// s_old returns during the window through a direct visit.
		{
			SiteID: mainSite.ID, Path: "/", Session: "s_old", Surface: analytics.SurfaceSite,
			Source: analytics.SourceDirect, Device: analytics.DeviceMobile,
			CreatedAt: time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC),
		},
		// s_new1 first appears from search, then navigates internally the same day.
		{
			SiteID: mainSite.ID, Path: "/a/1", Session: "s_new1", Surface: analytics.SurfaceSite,
			ReferrerHost: "www.google.com", Source: analytics.SourceSearch, Device: analytics.DeviceDesktop,
			CreatedAt: time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC),
		},
		{
			SiteID: mainSite.ID, Path: "/a/2", Session: "s_new1", Surface: analytics.SurfaceSite,
			Source: analytics.SourceInternal, Device: analytics.DeviceDesktop,
			CreatedAt: time.Date(2026, 10, 20, 10, 5, 0, 0, time.UTC),
		},
		// s_new2 arrives from social and later follows an external referral.
		{
			SiteID: mainSite.ID, Path: "/p/1", Session: "s_new2", Surface: analytics.SurfaceSite,
			ReferrerHost: "x.com", Source: analytics.SourceSocial, Device: analytics.DeviceTablet,
			CreatedAt: time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC),
		},
		{
			SiteID: mainSite.ID, Path: "/p/2", Session: "s_new2", Surface: analytics.SurfaceSite,
			ReferrerHost: "news.example.org", Source: analytics.SourceReferral, Device: analytics.DeviceTablet,
			CreatedAt: time.Date(2026, 10, 24, 11, 0, 0, 0, time.UTC),
		},
		// Never active in the window; only its first-seen row predates it.
		{
			SiteID: mainSite.ID, Path: "/a/gone", Session: "s_gone", Surface: analytics.SurfaceSite,
			Source: analytics.SourceDirect, Device: analytics.DeviceDesktop,
			CreatedAt: time.Date(2026, 10, 14, 10, 0, 0, 0, time.UTC),
		},
		// Admin traffic is recorded but never reported.
		{
			SiteID: mainSite.ID, Path: "/admin", Session: "s_admin", Surface: analytics.SurfaceAdmin,
			Source: analytics.SourceDirect, Device: analytics.DeviceDesktop,
			CreatedAt: time.Date(2026, 10, 20, 11, 0, 0, 0, time.UTC),
		},
		// Another tenant is never counted.
		{
			SiteID: otherSite.ID, Path: "/a/foreign", Session: "s_foreign", Surface: analytics.SurfaceSite,
			ReferrerHost: "x.com", Source: analytics.SourceSocial, Device: analytics.DeviceMobile,
			CreatedAt: time.Date(2026, 10, 20, 11, 30, 0, 0, time.UTC),
		},
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
	}, mainSite.ID, analytics.Range7d)
	require.NoError(t, err)

	// Existing totals are unchanged by the new columns.
	require.Equal(t, analytics.Totals{Views: 5, Sessions: 3, Online: 0}, report.Totals)

	require.Equal(t, []analytics.SourceCount{
		{Source: analytics.SourceDirect, Visits: 1, Sessions: 1},
		{Source: analytics.SourceInternal, Visits: 1, Sessions: 1},
		{Source: analytics.SourceReferral, Visits: 1, Sessions: 1},
		{Source: analytics.SourceSearch, Visits: 1, Sessions: 1},
		{Source: analytics.SourceSocial, Visits: 1, Sessions: 1},
	}, report.Sources)

	require.Equal(t, []analytics.DeviceCount{
		{Device: analytics.DeviceDesktop, Visits: 2, Sessions: 1},
		{Device: analytics.DeviceTablet, Visits: 2, Sessions: 1},
		{Device: analytics.DeviceMobile, Visits: 1, Sessions: 1},
	}, report.Devices)

	require.Equal(t, []analytics.ReferrerCount{
		{Host: "news.example.org", Visits: 1},
		{Host: "www.google.com", Visits: 1},
		{Host: "x.com", Visits: 1},
	}, report.TopReferrers)

	require.Len(t, report.Retention, 7)
	require.Equal(t, analytics.RetentionPoint{Date: "2026-10-18"}, report.Retention[0])
	require.Equal(t,
		analytics.RetentionPoint{Date: "2026-10-20", NewSessions: 1, ReturningSessions: 1},
		report.Retention[2],
		"the pre-window history turns s_old into a returning session",
	)
	require.Equal(t, analytics.RetentionPoint{Date: "2026-10-22"}, report.Retention[4])
	require.Equal(t,
		analytics.RetentionPoint{Date: "2026-10-23", NewSessions: 1},
		report.Retention[5],
	)
	require.Equal(t,
		analytics.RetentionPoint{Date: "2026-10-24", ReturningSessions: 1},
		report.Retention[6],
	)
}

// TestBodyReferrerPriorityFlowsIntoTopReferrers is the beta 1.2 source-data
// regression at the persistence boundary: a same-origin beacon always sends its own
// page as the Referer header, so the body referrer has to decide the source and the
// external host has to survive into top_referrers.
func TestBodyReferrerPriorityFlowsIntoTopReferrers(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "analytics-referrer.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("referrer").SetName("Referrer").Save(ctx)
	require.NoError(t, err)

	signals := analytics.DeriveVisitSignals(
		"https://www.google.com/search?q=hello",
		"https://blog.example.com/a/cnt_1",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
		"blog.example.com",
	)
	require.Equal(t, "www.google.com", signals.ReferrerHost)
	require.Equal(t, analytics.SourceSearch, signals.Source)

	store := analyticsstore.New(handle.Client)
	require.NoError(t, store.Insert(ctx, analytics.Visit{
		SiteID:       siteRow.ID,
		Path:         "/a/cnt_1",
		Session:      "s_body",
		Surface:      analytics.SurfaceSite,
		ReferrerHost: signals.ReferrerHost,
		Source:       signals.Source,
		Device:       signals.Device,
		CreatedAt:    now,
	}))

	service, err := analytics.NewService(analytics.ServiceConfig{
		Repository: store,
		Now:        func() time.Time { return now },
	})
	require.NoError(t, err)
	report, err := service.Report(ctx, analytics.Actor{
		UserID: "admin", SiteID: siteRow.ID, Role: site.RoleSiteAdmin,
	}, siteRow.ID, analytics.Range24h)
	require.NoError(t, err)

	require.Equal(t, []analytics.SourceCount{
		{Source: analytics.SourceSearch, Visits: 1, Sessions: 1},
	}, report.Sources)
	require.Equal(t, []analytics.ReferrerCount{
		{Host: "www.google.com", Visits: 1},
	}, report.TopReferrers)
}

// TestInsertNormalizesMissingSignals keeps old or direct callers working: a Visit
// without derived columns is stored as unknown instead of failing the enum.
func TestInsertNormalizesMissingSignals(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "analytics-legacy.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("legacy").SetName("Legacy").Save(ctx)
	require.NoError(t, err)

	store := analyticsstore.New(handle.Client)
	require.NoError(t, store.Insert(ctx, analytics.Visit{
		SiteID: siteRow.ID, Path: "/", Session: "s_legacy", Surface: analytics.SurfaceSite, CreatedAt: now,
	}))

	service, err := analytics.NewService(analytics.ServiceConfig{
		Repository: store,
		Now:        func() time.Time { return now },
	})
	require.NoError(t, err)
	report, err := service.Report(ctx, analytics.Actor{
		UserID: "admin", SiteID: siteRow.ID, Role: site.RoleSiteAdmin,
	}, siteRow.ID, analytics.Range24h)
	require.NoError(t, err)
	require.Equal(t, analytics.Totals{Views: 1, Sessions: 1, Online: 1}, report.Totals)
	require.Equal(t, []analytics.SourceCount{
		{Source: analytics.SourceUnknown, Visits: 1, Sessions: 1},
	}, report.Sources)
	require.Equal(t, []analytics.DeviceCount{
		{Device: analytics.DeviceUnknown, Visits: 1, Sessions: 1},
	}, report.Devices)
}
