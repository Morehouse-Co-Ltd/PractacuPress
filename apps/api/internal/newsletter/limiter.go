package newsletter

import (
	"strings"
	"sync"
	"time"
)

// SubscribeRateLimit is the contract's per IP budget for public subscriptions.
const (
	SubscribeRateLimit  = 10
	SubscribeRateWindow = time.Hour
)

// Limiter is a fixed window counter keyed by an opaque string.
//
// The key is a hash of the caller's IP address computed by the HTTP layer; the
// plaintext address never reaches this package, so even an in-memory map cannot leak
// who tried to subscribe. The limiter lives in process on purpose: it protects a
// single installation, and a restart resetting the counter is an accepted trade-off
// against adding another table for a ten-per-hour budget.
type Limiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	now     func() time.Time
	buckets map[string]bucket
	calls   int
}

// bucket is one key's current window.
type bucket struct {
	count int
	reset time.Time
}

// NewLimiter builds a limiter with the given budget. A non positive limit disables
// the limiter (Allow always reports true), which is how tests that do not model rate
// limiting can opt out.
func NewLimiter(limit int, window time.Duration, now func() time.Time) *Limiter {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	if window <= 0 {
		window = SubscribeRateWindow
	}
	return &Limiter{
		limit:   limit,
		window:  window,
		now:     now,
		buckets: make(map[string]bucket),
	}
}

// Allow records one attempt and reports whether it fits the budget.
func (l *Limiter) Allow(key string) bool {
	if l == nil || l.limit <= 0 {
		return true
	}
	key = keyKey(key)
	if key == "" {
		// An empty key would put every caller that did not send an IP in one
		// bucket; refusing is safer than handing out a shared allowance.
		return false
	}

	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	// Sweep expired buckets occasionally so a burst of unique addresses cannot grow
	// the map without bound.
	l.calls++
	if l.calls%256 == 0 {
		l.sweepLocked(now)
	}

	current, ok := l.buckets[key]
	if !ok || !now.Before(current.reset) {
		l.buckets[key] = bucket{count: 1, reset: now.Add(l.window)}
		return true
	}
	if current.count >= l.limit {
		return false
	}
	current.count++
	l.buckets[key] = current
	return true
}

// RetryAfter returns how long the key has to wait, for the Retry-After header.
func (l *Limiter) RetryAfter(key string) time.Duration {
	if l == nil || l.limit <= 0 {
		return 0
	}
	key = keyKey(key)
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	current, ok := l.buckets[key]
	if !ok || !now.Before(current.reset) {
		return 0
	}
	return current.reset.Sub(now)
}

func (l *Limiter) sweepLocked(now time.Time) {
	for key, current := range l.buckets {
		if !now.Before(current.reset) {
			delete(l.buckets, key)
		}
	}
}

// keyKey trims the key so two spellings of the same hash cannot share a bucket.
func keyKey(key string) string {
	return strings.TrimSpace(key)
}
