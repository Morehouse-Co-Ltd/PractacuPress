package content

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

// viewsNow is the fixed clock of these tests; a pointer lets a test move it across the
// de-duplication window without rebuilding the service.
type viewsClock struct{ at time.Time }

func (c *viewsClock) now() time.Time { return c.at }

func newViewsService(t *testing.T, repo Repository, clock *viewsClock) *Service {
	t.Helper()
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Sanitizer:  okSanitizer(),
		PublishMode: func(context.Context, string) (site.PublishMode, error) {
			return site.PublishModeOpen, nil
		},
		Now: clock.now,
	})
	require.NoError(t, err)
	return service
}

func atPtr(at time.Time) *time.Time { return &at }

// TestRankPopularPrefersRecentTraffic pins the whole point of the decay: a modest
// item published today outranks a much older item with more total reads.
func TestRankPopularPrefersRecentTraffic(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	items := []Content{
		// 300 reads but twenty days old.
		{ID: "old", ViewCount: 300, PublishedAt: atPtr(now.Add(-20 * 24 * time.Hour))},
		// 100 reads, published an hour ago.
		{ID: "hot", ViewCount: 100, PublishedAt: atPtr(now.Add(-time.Hour))},
	}

	ranked := RankPopular(items, now, 10)
	require.Len(t, ranked, 2)
	require.Equal(t, "hot", ranked[0].Content.ID)
	require.Greater(t, ranked[0].Score, ranked[1].Score)
}

// TestRankPopularWithoutTrafficIsNewestFirst keeps the old behaviour as the honest
// fallback: a site with no reads yet shows its newest items instead of an empty board.
func TestRankPopularWithoutTrafficIsNewestFirst(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	items := []Content{
		{ID: "b", PublishedAt: atPtr(now.Add(-2 * time.Hour))},
		{ID: "a", PublishedAt: atPtr(now.Add(-time.Hour))},
	}

	ranked := RankPopular(items, now, 10)
	require.Equal(t, []string{"a", "b"}, []string{ranked[0].Content.ID, ranked[1].Content.ID})
	for _, item := range ranked {
		require.Zero(t, item.Score)
	}
}

// TestRankPopularIsDeterministicOnTies makes the board stable across requests: equal
// scores fall back to reads, then publication date, then id.
func TestRankPopularIsDeterministicOnTies(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	at := now.Add(-24 * time.Hour)
	items := []Content{
		{ID: "c", ViewCount: 0, PublishedAt: atPtr(at)},
		{ID: "b", ViewCount: 0, PublishedAt: atPtr(at)},
		{ID: "a", ViewCount: 0, PublishedAt: atPtr(at)},
	}

	first := RankPopular(items, now, 10)
	second := RankPopular([]Content{items[2], items[0], items[1]}, now, 10)
	require.Equal(t, []string{"a", "b", "c"}, []string{
		first[0].Content.ID, first[1].Content.ID, first[2].Content.ID,
	})
	require.Equal(t, first, second, "the board must not depend on the candidate order")
}

// TestRankPopularLimitsAndToleratesMissingPublishTime covers the two edge cases the
// store can still produce: a page limit and a published row without a timestamp.
func TestRankPopularLimitsAndToleratesMissingPublishTime(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	items := []Content{
		{ID: "no-time", ViewCount: 50},
		{ID: "dated", ViewCount: 10, PublishedAt: atPtr(now.Add(-time.Hour))},
	}

	ranked := RankPopular(items, now, 1)
	require.Len(t, ranked, 1)
	require.Equal(t, "dated", ranked[0].Content.ID, "an item without a publish time cannot decay and scores 0")
	require.Zero(t, popularScore(items[0], now))
}

func TestParsePopularWindow(t *testing.T) {
	cases := []struct {
		raw     string
		want    string
		wantErr bool
	}{
		{raw: "", want: DefaultPopularWindow},
		{raw: "7d", want: PopularWindow7d},
		{raw: "30d", want: PopularWindow30d},
		{raw: " 90d ", want: PopularWindow90d},
		{raw: "1y", wantErr: true},
		{raw: "24h", wantErr: true},
	}
	for _, tc := range cases {
		got, err := ParsePopularWindow(tc.raw)
		if tc.wantErr {
			require.ErrorIs(t, err, ErrInvalidInput, "window %q", tc.raw)
			continue
		}
		require.NoError(t, err, "window %q", tc.raw)
		require.Equal(t, tc.want, got)
	}
}

// TestPopularRanksOnlyPublishedPublicItems is the visibility guard: a leaderboard must
// never be the way a draft or a direct-link-only item becomes discoverable.
func TestPopularRanksOnlyPublishedPublicItems(t *testing.T) {
	clock := &viewsClock{at: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)}
	repo := newFakeRepo()
	recent := clock.at.Add(-time.Hour)
	repo.items = map[string]Content{
		"public": {ID: "public", SiteID: "s1", Status: StatusPublished, AccessMode: AccessPublic,
			Kind: KindArticle, ViewCount: 5, PublishedAt: &recent},
		"draft": {ID: "draft", SiteID: "s1", Status: StatusDraft, AccessMode: AccessPublic,
			Kind: KindArticle, ViewCount: 900, PublishedAt: &recent},
		"locked": {ID: "locked", SiteID: "s1", Status: StatusPublished, AccessMode: AccessPassword,
			Kind: KindArticle, ViewCount: 800, PublishedAt: &recent},
	}
	service := newViewsService(t, repo, clock)

	ranked, err := service.Popular(context.Background(), Actor{SiteID: "s1"}, PopularQuery{})
	require.NoError(t, err)
	require.Len(t, ranked, 1)
	require.Equal(t, "public", ranked[0].Content.ID)
	require.Equal(t, "s1", repo.lastPopularFilter.SiteID)
	require.Equal(t, DefaultPopularLimit*popularCandidateFactor, repo.lastPopularFilter.Limit)
	require.WithinDuration(t, clock.at.Add(-30*24*time.Hour), repo.lastPopularFilter.PublishedSince, time.Second)
}

// TestPopularPassesNarrowingThrough keeps the kind, category and tag filters exact:
// the board is filtered by the same values the listing accepts.
func TestPopularPassesNarrowingThrough(t *testing.T) {
	clock := &viewsClock{at: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)}
	repo := newFakeRepo()
	recent := clock.at.Add(-time.Hour)
	repo.items = map[string]Content{
		"in": {ID: "in", SiteID: "s1", Status: StatusPublished, AccessMode: AccessPublic,
			Kind: KindPost, CategoryID: "cat_a", Tags: []string{"Go"}, ViewCount: 2, PublishedAt: &recent},
		"wrong-kind": {ID: "wrong-kind", SiteID: "s1", Status: StatusPublished, AccessMode: AccessPublic,
			Kind: KindArticle, CategoryID: "cat_a", Tags: []string{"Go"}, ViewCount: 7, PublishedAt: &recent},
		"wrong-tag": {ID: "wrong-tag", SiteID: "s1", Status: StatusPublished, AccessMode: AccessPublic,
			Kind: KindPost, CategoryID: "cat_a", Tags: []string{"Rust"}, ViewCount: 7, PublishedAt: &recent},
	}
	service := newViewsService(t, repo, clock)

	ranked, err := service.Popular(context.Background(), Actor{SiteID: "s1"}, PopularQuery{
		Kind: KindPost, CategoryID: "cat_a", Tag: "Go", Window: PopularWindow7d, Limit: 3,
	})
	require.NoError(t, err)
	require.Len(t, ranked, 1)
	require.Equal(t, "in", ranked[0].Content.ID)
	require.Equal(t, KindPost, repo.lastPopularFilter.Kind)
	require.Equal(t, "cat_a", repo.lastPopularFilter.CategoryID)
	require.Equal(t, "Go", repo.lastPopularFilter.Tag)
	require.WithinDuration(t, clock.at.Add(-7*24*time.Hour), repo.lastPopularFilter.PublishedSince, time.Second)

	// A malformed filter is refused instead of dropped: a dropped tag would widen the
	// board behind the caller's back.
	_, err = service.Popular(context.Background(), Actor{SiteID: "s1"}, PopularQuery{Tag: `bad"tag`})
	require.ErrorIs(t, err, ErrInvalidInput)
	_, err = service.Popular(context.Background(), Actor{SiteID: "s1"}, PopularQuery{Kind: Kind("page")})
	require.ErrorIs(t, err, ErrInvalidInput)
}

// TestRecordViewCountsOncePerWindow is the de-duplication contract: the same reader
// counts once inside the window, again after it, and never at all on a self read.
func TestRecordViewCountsOncePerWindow(t *testing.T) {
	clock := &viewsClock{at: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)}
	repo := newFakeRepo()
	repo.items = map[string]Content{
		"c1": {ID: "c1", SiteID: "s1", Status: StatusPublished},
	}
	service := newViewsService(t, repo, clock)
	ctx := context.Background()
	read := ViewInput{SiteID: "s1", ContentID: "c1", Session: "vs_abc"}

	require.NoError(t, service.RecordView(ctx, read))
	require.Equal(t, 1, repo.items["c1"].ViewCount)

	// A reload inside the window is the same read.
	require.NoError(t, service.RecordView(ctx, read))
	require.Equal(t, 1, repo.items["c1"].ViewCount)

	// A different reader is a different read.
	require.NoError(t, service.RecordView(ctx, ViewInput{SiteID: "s1", ContentID: "c1", Session: "vs_other"}))
	require.Equal(t, 2, repo.items["c1"].ViewCount)

	// The same reader after the window counts again.
	clock.at = clock.at.Add(ViewDedupeWindow + time.Minute)
	require.NoError(t, service.RecordView(ctx, read))
	require.Equal(t, 3, repo.items["c1"].ViewCount)

	// A self read is never counted.
	clock.at = clock.at.Add(2 * ViewDedupeWindow)
	require.NoError(t, service.RecordView(ctx, ViewInput{
		SiteID: "s1", ContentID: "c1", Session: "vs_abc", SelfView: true,
	}))
	require.Equal(t, 3, repo.items["c1"].ViewCount)
}

// TestRecordViewIsSilentForUncountableReads keeps the counter from inventing rows: an
// unpublished item, an unknown id and an empty input are all no-ops.
func TestRecordViewIsSilentForUncountableReads(t *testing.T) {
	clock := &viewsClock{at: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)}
	repo := newFakeRepo()
	repo.items = map[string]Content{
		"draft": {ID: "draft", SiteID: "s1", Status: StatusDraft},
	}
	service := newViewsService(t, repo, clock)
	ctx := context.Background()

	require.NoError(t, service.RecordView(ctx, ViewInput{SiteID: "s1", ContentID: "draft", Session: "vs_a"}))
	require.Zero(t, repo.items["draft"].ViewCount)
	require.NoError(t, service.RecordView(ctx, ViewInput{SiteID: "s1", ContentID: "ghost", Session: "vs_a"}))
	require.NoError(t, service.RecordView(ctx, ViewInput{ContentID: "draft", Session: "vs_a"}))
}

func TestViewKeyPrefersTheStrongestIdentity(t *testing.T) {
	base := ViewInput{SiteID: "s1", ContentID: "c1", UserID: "u1", Session: "vs_a", IP: "10.0.0.1"}
	require.Equal(t, "s1\x00c1\x00u:u1", viewKey(base))

	anonymous := base
	anonymous.UserID = ""
	require.Equal(t, "s1\x00c1\x00s:vs_a", viewKey(anonymous))

	addressOnly := anonymous
	addressOnly.Session = ""
	require.Equal(t, "s1\x00c1\x00ip:10.0.0.1", viewKey(addressOnly))

	// Nothing to tell readers apart: one shared key, which can only under-count.
	require.Equal(t, "s1\x00c1\x00anon", viewKey(ViewInput{SiteID: "s1", ContentID: "c1"}))

	// A pathological session header is truncated rather than rejected, so a read is
	// never dropped because of its de-duplication hint.
	long := base
	long.UserID = ""
	long.Session = string(make([]byte, 200))
	require.Len(t, viewKey(long), len("s1\x00c1\x00s:")+maxViewSessionLength)
}
