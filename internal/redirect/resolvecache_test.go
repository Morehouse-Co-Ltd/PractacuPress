package redirect

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeClock is a deterministic clock for the cache TTL tests.
type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time { return c.now }

func TestResolveCacheHitAndMiss(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)}
	cache := newResolveCache(10, time.Minute, clock.Now)

	_, ok := cache.Get("site_1", "/a/old")
	require.False(t, ok)

	resolution := Resolution{Kind: KindRedirect, CanonicalPath: "/a/new", Status: 301}
	cache.Put("site_1", "/a/old", resolution)

	got, ok := cache.Get("site_1", "/a/old")
	require.True(t, ok)
	require.Equal(t, resolution, got)

	// The site is part of the key: another tenant's identical path must not hit.
	_, ok = cache.Get("site_2", "/a/old")
	require.False(t, ok)
}

func TestResolveCacheExpires(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)}
	cache := newResolveCache(10, time.Minute, clock.Now)

	cache.Put("site_1", "/a/old", Resolution{Kind: KindMissing, Status: 404})
	_, ok := cache.Get("site_1", "/a/old")
	require.True(t, ok)

	clock.now = clock.now.Add(time.Minute)
	_, ok = cache.Get("site_1", "/a/old")
	require.False(t, ok, "an entry past its TTL is dropped")

	// A fresh put after expiry starts a new entry.
	cache.Put("site_1", "/a/old", Resolution{Kind: KindContent, Status: 200})
	got, ok := cache.Get("site_1", "/a/old")
	require.True(t, ok)
	require.Equal(t, KindContent, got.Kind)
}

func TestResolveCacheEvictsLeastRecentlyUsed(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)}
	cache := newResolveCache(2, time.Minute, clock.Now)

	cache.Put("site_1", "/a/one", Resolution{Kind: KindContent, Status: 200})
	cache.Put("site_1", "/a/two", Resolution{Kind: KindContent, Status: 200})

	// Touch the first entry so the second becomes the least recently used.
	_, ok := cache.Get("site_1", "/a/one")
	require.True(t, ok)

	cache.Put("site_1", "/a/three", Resolution{Kind: KindContent, Status: 200})

	_, ok = cache.Get("site_1", "/a/two")
	require.False(t, ok, "the least recently used entry is evicted")
	_, ok = cache.Get("site_1", "/a/one")
	require.True(t, ok)
	_, ok = cache.Get("site_1", "/a/three")
	require.True(t, ok)
}

func TestResolveCachePurgeDropsOneSite(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)}
	cache := newResolveCache(10, time.Minute, clock.Now)

	cache.Put("site_1", "/a/old", Resolution{Kind: KindContent, Status: 200})
	cache.Put("site_1", "/p/old", Resolution{Kind: KindContent, Status: 200})
	cache.Put("site_2", "/a/old", Resolution{Kind: KindContent, Status: 200})

	cache.Purge("site_1")

	_, ok := cache.Get("site_1", "/a/old")
	require.False(t, ok)
	_, ok = cache.Get("site_1", "/p/old")
	require.False(t, ok)
	_, ok = cache.Get("site_2", "/a/old")
	require.True(t, ok, "another site's entries survive")
}

func TestResolveCacheDisabled(t *testing.T) {
	cache := newResolveCache(0, time.Minute, nil)
	cache.Put("site_1", "/a/old", Resolution{Kind: KindContent, Status: 200})
	_, ok := cache.Get("site_1", "/a/old")
	require.False(t, ok, "a zero size disables the cache")

	cache = newResolveCache(10, 0, nil)
	cache.Put("site_1", "/a/old", Resolution{Kind: KindContent, Status: 200})
	_, ok = cache.Get("site_1", "/a/old")
	require.False(t, ok, "a zero TTL disables the cache")

	// A nil cache is a no-op rather than a panic; the handler always builds one.
	var nilCache *resolveCache
	nilCache.Put("site_1", "/a/old", Resolution{})
	_, ok = nilCache.Get("site_1", "/a/old")
	require.False(t, ok)
}
