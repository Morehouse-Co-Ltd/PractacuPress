package analytics

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

type fakeRepo struct {
	visits    []Visit
	aggregate Aggregate
	query     Query
	err       error
}

func (f *fakeRepo) Insert(_ context.Context, visit Visit) error {
	if f.err != nil {
		return f.err
	}
	f.visits = append(f.visits, visit)
	return nil
}

func (f *fakeRepo) Aggregate(_ context.Context, query Query) (Aggregate, error) {
	f.query = query
	if f.err != nil {
		return Aggregate{}, f.err
	}
	return f.aggregate, nil
}

func newTestService(t *testing.T, repo Repository, now time.Time) *Service {
	t.Helper()
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Now:        func() time.Time { return now },
	})
	require.NoError(t, err)
	return service
}

func TestRecordStampsSiteAndClock(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 34, 56, 0, time.UTC)
	repo := &fakeRepo{}
	service := newTestService(t, repo, now)

	err := service.Record(context.Background(), "site_1", VisitInput{
		Path:     "/",
		Title:    "Home",
		Referrer: "https://example.test/",
		Session:  "vs_1",
		Surface:  SurfaceSite,
	})
	require.NoError(t, err)
	require.Len(t, repo.visits, 1)
	require.Equal(t, "site_1", repo.visits[0].SiteID)
	require.Equal(t, now, repo.visits[0].CreatedAt)

	require.ErrorIs(t, service.Record(context.Background(), "", VisitInput{
		Path: "/", Session: "vs_1", Surface: SurfaceSite,
	}), ErrInvalidInput)
	require.ErrorIs(t, service.Record(context.Background(), "site_1", VisitInput{
		Path: "/", Session: "vs_1", Surface: "server",
	}), ErrInvalidInput)
}

func TestReportAuthorization(t *testing.T) {
	service := newTestService(t, &fakeRepo{}, time.Now())

	member := Actor{UserID: "u1", SiteID: "site_1", Role: site.RoleMember}
	otherSite := Actor{UserID: "u1", SiteID: "site_2", Role: site.RoleSiteAdmin}
	admin := Actor{UserID: "u2", SiteID: "site_1", Role: site.RoleSiteAdmin}

	_, err := service.Report(context.Background(), Actor{}, "site_1", Range24h)
	require.ErrorIs(t, err, ErrPermissionDenied)

	_, err = service.Report(context.Background(), otherSite, "site_1", Range24h)
	require.ErrorIs(t, err, ErrCrossSite)

	_, err = service.Report(context.Background(), member, "site_1", Range24h)
	require.ErrorIs(t, err, ErrPermissionDenied)

	_, err = service.Report(context.Background(), admin, "site_1", Range("90d"))
	require.ErrorIs(t, err, ErrInvalidInput)

	report, err := service.Report(context.Background(), admin, "site_1", "")
	require.NoError(t, err)
	require.Equal(t, Range24h, report.Range, "empty range defaults to 24h")
	require.Len(t, report.Series, 24)
}

func TestReportBucketsAndRankings(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 34, 56, 0, time.UTC)
	repo := &fakeRepo{aggregate: Aggregate{
		Views:    6,
		Sessions: 4,
		Online:   2,
		Timestamps: []time.Time{
			now,
			now.Add(-30 * time.Minute),
			now.Add(-time.Hour),
			now.Add(-time.Hour),
			now.Add(-24 * time.Hour),
			now.Add(-48 * time.Hour), // outside the 24h window
		},
		PageCounts: []TopPage{
			{Path: "/a/cnt_1", Count: 3},
			{Path: "/p/pst_1", Count: 2},
			{Path: "/", Count: 2},
			{Path: "/a/cnt_1?from=share", Count: 1},
		},
	}}
	service := newTestService(t, repo, now)

	report, err := service.Report(context.Background(), Actor{
		UserID: "u1", SiteID: "site_1", Role: site.RolePlatformAdmin,
	}, "site_1", Range24h)
	require.NoError(t, err)

	require.Equal(t, Totals{Views: 6, Sessions: 4, Online: 2}, report.Totals)
	require.Len(t, report.Series, 24)

	// Four timestamps land in the window; the row at -24h is already before the
	// first bucket and the row at -48h is far outside.
	sum := 0
	for _, point := range report.Series {
		sum += point.Count
	}
	require.Equal(t, 4, sum)

	require.Equal(t, time.Date(2026, 10, 23, 13, 0, 0, 0, time.UTC), repo.query.Start)
	require.Equal(t, now.Add(-OnlineWindow), repo.query.OnlineSince)

	require.Equal(t, []TopPage{
		{Path: "/a/cnt_1", Count: 3},
		{Path: "/", Count: 2},
		{Path: "/p/pst_1", Count: 2},
		{Path: "/a/cnt_1?from=share", Count: 1},
	}, report.TopPages)

	// /a/cnt_1 and its share-link variant are the same content.
	require.Equal(t, []TopContent{{ID: "cnt_1", Count: 4}, {ID: "pst_1", Count: 2}}, report.TopContent)
}

func TestReportRangeShapes(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	service := newTestService(t, &fakeRepo{}, now)
	actor := Actor{UserID: "u1", SiteID: "site_1", Role: site.RoleSiteAdmin}

	for _, tc := range []struct {
		rangeValue Range
		buckets    int
	}{
		{Range24h, 24},
		{Range7d, 7},
		{Range30d, 30},
	} {
		report, err := service.Report(context.Background(), actor, "site_1", tc.rangeValue)
		require.NoError(t, err)
		require.Len(t, report.Series, tc.buckets, string(tc.rangeValue))
		require.NotNil(t, report.TopPages)
		require.NotNil(t, report.TopContent)
	}
}

func TestReportPropagatesRepositoryFailure(t *testing.T) {
	service := newTestService(t, &fakeRepo{err: errors.New("db down")}, time.Now())
	_, err := service.Report(context.Background(), Actor{
		UserID: "u1", SiteID: "site_1", Role: site.RoleSiteAdmin,
	}, "site_1", Range24h)
	require.Error(t, err)
}

// TestRecordDeduplicatesPerSessionAndPathMinute pins the V-10 noise filter: one
// session viewing one path is stored once per minute, and the window is per site.
func TestRecordDeduplicatesPerSessionAndPathMinute(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{}
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Now:        func() time.Time { return now },
	})
	require.NoError(t, err)

	visit := VisitInput{Path: "/a/cnt_1", Session: "vs_1", Surface: SurfaceSite}
	require.NoError(t, service.Record(context.Background(), "site_1", visit))
	require.NoError(t, service.Record(context.Background(), "site_1", visit))
	require.Len(t, repo.visits, 1, "a duplicate inside the same minute is dropped")

	// A different session and a different path are distinct views.
	require.NoError(t, service.Record(context.Background(), "site_1", VisitInput{
		Path: "/a/cnt_1", Session: "vs_2", Surface: SurfaceSite,
	}))
	require.NoError(t, service.Record(context.Background(), "site_1", VisitInput{
		Path: "/", Session: "vs_1", Surface: SurfaceSite,
	}))
	require.Len(t, repo.visits, 3)

	// The same session and path on another tenant must not be suppressed.
	require.NoError(t, service.Record(context.Background(), "site_2", visit))
	require.Len(t, repo.visits, 4)

	// The next minute is a new window.
	now = now.Add(time.Minute)
	require.NoError(t, service.Record(context.Background(), "site_1", visit))
	require.Len(t, repo.visits, 5)

	// A rejected visit never enters the dedupe table: fixing the payload must work
	// in the same minute.
	require.ErrorIs(t, service.Record(context.Background(), "site_1", VisitInput{
		Path: "relative", Session: "vs_1", Surface: SurfaceSite,
	}), ErrInvalidInput)
	require.NoError(t, service.Record(context.Background(), "site_1", VisitInput{
		Path: "/ok", Session: "vs_1", Surface: SurfaceSite,
	}))
	require.Len(t, repo.visits, 6)
}
