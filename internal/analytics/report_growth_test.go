package analytics

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

func adminActor() Actor {
	return Actor{UserID: "u1", SiteID: "site_1", Role: site.RoleSiteAdmin}
}

// TestReportGrowthBlocks pins the four additions of the beta 1.2 contract: source,
// device, referrer leaderboard and retention, including their order and shape.
func TestReportGrowthBlocks(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{aggregate: Aggregate{
		Views:      5,
		Sessions:   3,
		Online:     1,
		Timestamps: []time.Time{now.Add(-time.Hour), now.Add(-2 * time.Hour)},
		PageCounts: []TopPage{{Path: "/", Count: 5}},
		SourceCounts: []SourceCount{
			{Source: SourceSearch, Visits: 3, Sessions: 2},
			{Source: SourceDirect, Visits: 2, Sessions: 2},
			{Source: SourceInternal, Visits: 1, Sessions: 1},
			{Source: SourceSocial, Visits: 1, Sessions: 1},
			{Source: SourceReferral, Visits: 1, Sessions: 1},
		},
		DeviceCounts: []DeviceCount{
			{Device: DeviceMobile, Visits: 3, Sessions: 2},
			{Device: DeviceDesktop, Visits: 2, Sessions: 2},
			{Device: DeviceTablet, Visits: 1, Sessions: 1},
			{Device: DeviceBot, Visits: 1, Sessions: 1},
		},
		ReferrerCounts: []ReferrerCount{
			{Host: "news.example.org", Visits: 2},
			{Host: "www.google.com", Visits: 2},
			{Host: "x.com", Visits: 1},
		},
		SessionVisits: []SessionVisit{
			{Session: "s_old", At: time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)},
			{Session: "s_new", At: time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)},
			{Session: "s_new", At: time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)},
			{Session: "s_old", At: time.Date(2026, 10, 24, 10, 0, 0, 0, time.UTC)},
		},
		SessionFirstSeen: []SessionFirstSeen{
			{Session: "s_old", FirstAt: time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)},
			{Session: "s_new", FirstAt: time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)},
		},
	}}
	service := newTestService(t, repo, now)

	report, err := service.Report(context.Background(), adminActor(), "site_1", Range7d)
	require.NoError(t, err)

	// Source ordering: visits descending, then the class name for stability.
	require.Equal(t, []SourceCount{
		{Source: SourceSearch, Visits: 3, Sessions: 2},
		{Source: SourceDirect, Visits: 2, Sessions: 2},
		{Source: SourceInternal, Visits: 1, Sessions: 1},
		{Source: SourceReferral, Visits: 1, Sessions: 1},
		{Source: SourceSocial, Visits: 1, Sessions: 1},
	}, report.Sources)

	require.Equal(t, []DeviceCount{
		{Device: DeviceMobile, Visits: 3, Sessions: 2},
		{Device: DeviceDesktop, Visits: 2, Sessions: 2},
		{Device: DeviceBot, Visits: 1, Sessions: 1},
		{Device: DeviceTablet, Visits: 1, Sessions: 1},
	}, report.Devices)

	require.Equal(t, []ReferrerCount{
		{Host: "news.example.org", Visits: 2},
		{Host: "www.google.com", Visits: 2},
		{Host: "x.com", Visits: 1},
	}, report.TopReferrers)

	// Seven calendar days, oldest first.
	require.Len(t, report.Retention, 7)
	require.Equal(t, RetentionPoint{Date: "2026-10-18"}, report.Retention[0])
	require.Equal(t, RetentionPoint{Date: "2026-10-20", NewSessions: 1, ReturningSessions: 1}, report.Retention[2])
	require.Equal(t, RetentionPoint{Date: "2026-10-22", NewSessions: 0, ReturningSessions: 1}, report.Retention[4])
	require.Equal(t, RetentionPoint{Date: "2026-10-24", NewSessions: 0, ReturningSessions: 1}, report.Retention[6])

	// The existing blocks are unchanged and remain present.
	require.Equal(t, Range7d, report.Range)
	require.Len(t, report.Series, 7)
	require.Equal(t, []TopPage{{Path: "/", Count: 5}}, report.TopPages)
}

// TestReportRetentionCountsFirstDayOfSessionAsNew checks the new/returning split on a
// session that is active on several consecutive days: new exactly once, returning
// afterwards.
func TestReportRetentionCountsFirstDayOfSessionAsNew(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{aggregate: Aggregate{
		SessionVisits: []SessionVisit{
			{Session: "a", At: time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC)},
			{Session: "a", At: time.Date(2026, 10, 20, 8, 0, 0, 0, time.UTC)},
			{Session: "a", At: time.Date(2026, 10, 21, 8, 0, 0, 0, time.UTC)},
			{Session: "b", At: time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)},
		},
		SessionFirstSeen: []SessionFirstSeen{
			{Session: "a", FirstAt: time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC)},
			{Session: "b", FirstAt: time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)},
		},
	}}
	service := newTestService(t, repo, now)

	report, err := service.Report(context.Background(), adminActor(), "site_1", Range7d)
	require.NoError(t, err)

	want := map[string]RetentionPoint{
		"2026-10-18": {Date: "2026-10-18"},
		"2026-10-19": {Date: "2026-10-19", NewSessions: 1},
		"2026-10-20": {Date: "2026-10-20", ReturningSessions: 1},
		"2026-10-21": {Date: "2026-10-21", NewSessions: 1, ReturningSessions: 1},
		"2026-10-22": {Date: "2026-10-22"},
		"2026-10-23": {Date: "2026-10-23"},
		"2026-10-24": {Date: "2026-10-24"},
	}
	require.Len(t, report.Retention, len(want))
	for _, point := range report.Retention {
		require.Equal(t, want[point.Date], point, point.Date)
	}
}

// TestReportRetentionUsesReaderZone pins the calendar day boundary: the same UTC
// instant belongs to different retention days for different readers, so the reader's
// offset decides.
func TestReportRetentionUsesReaderZone(t *testing.T) {
	// 02:00 UTC is 10:00 in UTC+8, so "today" is 2026-10-24 for that reader.
	now := time.Date(2026, 10, 24, 2, 0, 0, 0, time.UTC)
	repo := &fakeRepo{aggregate: Aggregate{
		SessionVisits: []SessionVisit{
			// 16:30 UTC on 10-20 is 00:30 on 10-21 in UTC+8.
			{Session: "s", At: time.Date(2026, 10, 20, 16, 30, 0, 0, time.UTC)},
			{Session: "s", At: time.Date(2026, 10, 20, 17, 30, 0, 0, time.UTC)},
		},
		SessionFirstSeen: []SessionFirstSeen{
			{Session: "s", FirstAt: time.Date(2026, 10, 20, 16, 30, 0, 0, time.UTC)},
		},
	}}
	service := newTestService(t, repo, now)

	report, err := service.Report(context.Background(), adminActor(), "site_1", Range7d, 8*60)
	require.NoError(t, err)

	byDate := make(map[string]RetentionPoint, len(report.Retention))
	for _, point := range report.Retention {
		byDate[point.Date] = point
	}
	require.Equal(t, RetentionPoint{Date: "2026-10-21", NewSessions: 1}, byDate["2026-10-21"])
	require.Equal(t, RetentionPoint{Date: "2026-10-20"}, byDate["2026-10-20"], "no session is active on the UTC day")
}

// TestReportRetention24hSpansTwoCalendarDays documents the 24h layout: the hourly
// window is not aligned to midnight, so retention covers every calendar day the
// window touches.
func TestReportRetention24hSpansTwoCalendarDays(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{aggregate: Aggregate{
		SessionVisits: []SessionVisit{
			{Session: "s", At: time.Date(2026, 10, 23, 23, 0, 0, 0, time.UTC)},
			{Session: "s", At: time.Date(2026, 10, 24, 11, 0, 0, 0, time.UTC)},
		},
		SessionFirstSeen: []SessionFirstSeen{
			{Session: "s", FirstAt: time.Date(2026, 10, 23, 23, 0, 0, 0, time.UTC)},
		},
	}}
	service := newTestService(t, repo, now)

	report, err := service.Report(context.Background(), adminActor(), "site_1", Range24h)
	require.NoError(t, err)

	require.Equal(t, []RetentionPoint{
		{Date: "2026-10-23", NewSessions: 1},
		{Date: "2026-10-24", ReturningSessions: 1},
	}, report.Retention)
}

// TestReportTopReferrersIsBounded keeps the leaderboard from growing with the site's
// link graph.
func TestReportTopReferrersIsBounded(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	const hosts = MaxTopReferrers + 4
	counts := make([]ReferrerCount, 0, hosts)
	for index := 0; index < hosts; index++ {
		counts = append(counts, ReferrerCount{
			Host:   "site-" + string(rune('a'+index)) + ".example",
			Visits: hosts - index,
		})
	}
	repo := &fakeRepo{aggregate: Aggregate{ReferrerCounts: counts}}
	service := newTestService(t, repo, now)

	report, err := service.Report(context.Background(), adminActor(), "site_1", Range24h)
	require.NoError(t, err)
	require.Len(t, report.TopReferrers, MaxTopReferrers)
	require.Equal(t, "site-a.example", report.TopReferrers[0].Host)
}

// TestReportEmptyGrowthBlocksAreEmptySlices keeps the JSON shape stable: an empty
// block must encode as [] rather than null.
func TestReportEmptyGrowthBlocksAreEmptySlices(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	service := newTestService(t, &fakeRepo{}, now)

	report, err := service.Report(context.Background(), adminActor(), "site_1", Range24h)
	require.NoError(t, err)
	require.NotNil(t, report.Sources)
	require.NotNil(t, report.Devices)
	require.NotNil(t, report.TopReferrers)
	require.NotNil(t, report.Retention)
	require.Len(t, report.Sources, 0)
	require.Len(t, report.Devices, 0)
	require.Len(t, report.TopReferrers, 0)
	require.NotEmpty(t, report.Retention, "the day buckets exist even with no traffic")
}

// TestReportRejectsInvalidRange pins the contract's 400 for an unknown window.
func TestReportRejectsInvalidRange(t *testing.T) {
	service := newTestService(t, &fakeRepo{}, time.Now())
	_, err := service.Report(context.Background(), adminActor(), "site_1", Range("90d"))
	require.ErrorIs(t, err, ErrInvalidInput)
}
