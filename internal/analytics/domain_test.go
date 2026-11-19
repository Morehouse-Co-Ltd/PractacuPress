package analytics

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestParseRange(t *testing.T) {
	for _, raw := range []string{"", "24h", "7d", "30d"} {
		got, err := ParseRange(raw)
		require.NoError(t, err, raw)
		require.True(t, got.Valid())
	}

	for _, raw := range []string{"1h", "90d", "day"} {
		_, err := ParseRange(raw)
		require.ErrorIs(t, err, ErrInvalidInput, raw)
	}
}

func TestValidateVisit(t *testing.T) {
	valid := VisitInput{
		Path:     " /articles/1 ",
		Title:    "Hello",
		Referrer: "https://example.test/",
		Session:  "vs_123",
		Surface:  SurfaceSite,
	}
	got, err := ValidateVisit(valid)
	require.NoError(t, err)
	require.Equal(t, "/articles/1", got.Path)
	require.Equal(t, "vs_123", got.Session)

	cases := map[string]VisitInput{
		"missing path":    {Session: "vs_1", Surface: SurfaceSite},
		"relative path":   {Path: "articles", Session: "vs_1", Surface: SurfaceSite},
		"missing session": {Path: "/", Surface: SurfaceSite},
		"unknown surface": {Path: "/", Session: "vs_1", Surface: "server"},
		"long session":    {Path: "/", Session: string(make([]byte, MaxSessionLength+1)), Surface: SurfaceSite},
	}
	for name, in := range cases {
		_, err := ValidateVisit(in)
		require.Error(t, err, name)
	}
}

func TestWindowBuckets(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 34, 56, 0, time.UTC)

	window24 := Range24h.Window(now)
	require.Len(t, window24.Labels, 24)
	require.Equal(t, time.Date(2026, 10, 23, 13, 0, 0, 0, time.UTC), window24.Start)
	require.Equal(t, "13:00", window24.Labels[0])
	require.Equal(t, "12:00", window24.Labels[23])

	index, ok := window24.Index(now)
	require.True(t, ok)
	require.Equal(t, 23, index)

	window7 := Range7d.Window(now)
	require.Len(t, window7.Labels, 7)
	require.Equal(t, time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC), window7.Start)
	require.Equal(t, "10/18", window7.Labels[0])
	require.Equal(t, "10/24", window7.Labels[6])

	window30 := Range30d.Window(now)
	require.Len(t, window30.Labels, 30)
	require.Equal(t, time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC), window30.Start)
	require.Equal(t, "9/25", window30.Labels[0])
	require.Equal(t, "10/24", window30.Labels[29])

	_, ok = window7.Index(window7.Start.Add(-time.Second))
	require.False(t, ok)
	_, ok = window7.Index(window7.End())
	require.False(t, ok)
}

func TestContentIDFromPath(t *testing.T) {
	cases := map[string]string{
		"/a/cnt_house":         "cnt_house",
		"/p/pst_rss?from=feed": "pst_rss",
		"/a/uuid-123#top":      "uuid-123",
		"/a/x/y":               "x",
	}
	for path, want := range cases {
		got, ok := ContentIDFromPath(path)
		require.True(t, ok, path)
		require.Equal(t, want, got, path)
	}

	for _, path := range []string{"/", "/articles/x", "/a/", "/ap/x"} {
		_, ok := ContentIDFromPath(path)
		require.False(t, ok, path)
	}
}
