package redirect

import (
	"container/list"
	"sync"
	"time"
)

// Defaults of the in-process resolve cache. The resolve endpoint is called by the
// static server and by crawlers in front of every page view, so a minute of reuse
// removes almost every duplicate database read only a burst of crawlers could see.
const (
	// DefaultResolveTTL is how long a resolution stays cacheable.
	DefaultResolveTTL = 60 * time.Second
	// DefaultResolveCacheSize bounds the cache; an LRU keeps the hottest paths when a
	// long tail of crawled URLs would otherwise grow it without limit.
	DefaultResolveCacheSize = 1000
)

// resolveCache is a small concurrency safe LRU of path resolutions.
//
// It is intentionally per process: the data is cheap to rebuild, a stale entry lives at
// most one TTL, and a multi-instance deployment does not need a shared cache to keep
// the database read rate sane.
type resolveCache struct {
	mu      sync.Mutex
	entries map[string]*list.Element
	order   *list.List
	max     int
	ttl     time.Duration
	now     func() time.Time
}

// resolveCacheEntry is one stored resolution.
type resolveCacheEntry struct {
	key       string
	value     Resolution
	expiresAt time.Time
}

// newResolveCache builds a cache. A non-positive size or TTL disables it, which is what
// tests use to prove the endpoint works without caching.
func newResolveCache(max int, ttl time.Duration, now func() time.Time) *resolveCache {
	if now == nil {
		now = func() time.Time { return time.Now() }
	}
	return &resolveCache{
		entries: make(map[string]*list.Element, max),
		order:   list.New(),
		max:     max,
		ttl:     ttl,
		now:     now,
	}
}

// cacheKey namespaces one path by site, so the same path on two hostnames cannot leak
// one tenant's canonical URL to another.
func cacheKey(siteID, path string) string { return siteID + "\x00" + path }

// Get returns a cached resolution.
func (c *resolveCache) Get(siteID, path string) (Resolution, bool) {
	if c == nil || c.max <= 0 || c.ttl <= 0 {
		return Resolution{}, false
	}

	key := cacheKey(siteID, path)

	c.mu.Lock()
	defer c.mu.Unlock()

	element, ok := c.entries[key]
	if !ok {
		return Resolution{}, false
	}
	entry := element.Value.(*resolveCacheEntry)
	if !c.now().Before(entry.expiresAt) {
		c.remove(element)
		return Resolution{}, false
	}
	c.order.MoveToFront(element)
	return entry.value, true
}

// Put stores a resolution. Only successful resolutions reach this method: an error is
// never cached, so a transient database failure cannot pin a 404 for a minute.
func (c *resolveCache) Put(siteID, path string, value Resolution) {
	if c == nil || c.max <= 0 || c.ttl <= 0 {
		return
	}

	key := cacheKey(siteID, path)
	expiresAt := c.now().Add(c.ttl)

	c.mu.Lock()
	defer c.mu.Unlock()

	if element, ok := c.entries[key]; ok {
		entry := element.Value.(*resolveCacheEntry)
		entry.value = value
		entry.expiresAt = expiresAt
		c.order.MoveToFront(element)
		return
	}

	c.entries[key] = c.order.PushFront(&resolveCacheEntry{
		key:       key,
		value:     value,
		expiresAt: expiresAt,
	})
	for c.order.Len() > c.max {
		c.remove(c.order.Back())
	}
}

// Purge drops every cached path of one site.
//
// It runs after a management write so an administrator who just moved a rule does not
// have to wait out the TTL to see the new target. Clearing the whole site instead of
// tracking affected keys keeps the cache and the write paths simple; a site's table is
// small and the cache refills from one request per path.
func (c *resolveCache) Purge(siteID string) {
	if c == nil || c.max <= 0 {
		return
	}

	prefix := siteID + "\x00"

	c.mu.Lock()
	defer c.mu.Unlock()

	for key, element := range c.entries {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			c.remove(element)
		}
	}
}

// remove drops one element from both the map and the order list.
func (c *resolveCache) remove(element *list.Element) {
	if element == nil {
		return
	}
	entry := element.Value.(*resolveCacheEntry)
	delete(c.entries, entry.key)
	c.order.Remove(element)
}
