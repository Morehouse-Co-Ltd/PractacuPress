package middleware

import (
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// RateLimitStore counts requests per key within a window.
//
// It is an interface because the in memory implementation below is only correct
// for a single process. A multi replica deployment needs a shared store, and that
// swap must not touch the middleware.
type RateLimitStore interface {
	// Allow records one request for key and reports whether it is within limit.
	// When it is not, retryAfter is how long the caller should wait.
	Allow(key string, limit int, window time.Duration) (allowed bool, retryAfter time.Duration)
}

// defaultRateLimitEntries bounds the in memory store so a key flood cannot exhaust
// memory. Expired windows are evicted first when the bound is reached.
const defaultRateLimitEntries = 50000

type fixedWindow struct {
	count   int
	resetAt time.Time
}

// MemoryRateLimitStore is a per process fixed window counter.
//
// Fixed windows are used instead of a sliding log because the extra precision is
// not worth the memory: the goal is to blunt abuse, not to bill exactly.
type MemoryRateLimitStore struct {
	mu         sync.Mutex
	now        func() time.Time
	windows    map[string]*fixedWindow
	maxEntries int
}

// NewMemoryRateLimitStore builds a store. A nil clock means time.Now, which tests
// replace to control the window deterministically.
func NewMemoryRateLimitStore(now func() time.Time) *MemoryRateLimitStore {
	if now == nil {
		now = time.Now
	}
	return &MemoryRateLimitStore{
		now:        now,
		windows:    make(map[string]*fixedWindow),
		maxEntries: defaultRateLimitEntries,
	}
}

// Allow implements RateLimitStore.
func (s *MemoryRateLimitStore) Allow(key string, limit int, window time.Duration) (bool, time.Duration) {
	if limit <= 0 {
		return true, 0
	}

	now := s.now()

	s.mu.Lock()
	defer s.mu.Unlock()

	current, ok := s.windows[key]
	if !ok || !now.Before(current.resetAt) {
		if !ok && len(s.windows) >= s.maxEntries {
			s.evictExpiredLocked(now)
			if len(s.windows) >= s.maxEntries {
				// Every entry is still inside its window. Keeping the key would grow
				// the map without bound (the exact memory exhaustion the ceiling is
				// meant to prevent), so evict one arbitrary entry instead. Fixed
				// windows are approximate by design; dropping one counter lets one
				// client reset its budget slightly early, which is preferable to an
				// attacker exhausting the process with unique keys.
				for victim := range s.windows {
					delete(s.windows, victim)
					break
				}
			}
		}
		s.windows[key] = &fixedWindow{count: 1, resetAt: now.Add(window)}
		return true, 0
	}

	if current.count >= limit {
		return false, current.resetAt.Sub(now)
	}

	current.count++
	return true, 0
}

func (s *MemoryRateLimitStore) evictExpiredLocked(now time.Time) {
	for key, window := range s.windows {
		if !now.Before(window.resetAt) {
			delete(s.windows, key)
		}
	}
}

// Policy configures one rate limit tier.
type Policy struct {
	// Limit is the allowed number of requests per window. Zero disables the tier.
	Limit int
	// Window defaults to one minute.
	Window time.Duration
	// Key defaults to the client IP.
	Key func(*gin.Context) string
}

// RateLimit rejects requests that exceed the policy.
func RateLimit(store RateLimitStore, policy Policy) gin.HandlerFunc {
	keyOf := policy.Key
	if keyOf == nil {
		keyOf = func(c *gin.Context) string { return c.ClientIP() }
	}
	window := policy.Window
	if window <= 0 {
		window = time.Minute
	}

	return func(c *gin.Context) {
		allowed, retryAfter := store.Allow(keyOf(c), policy.Limit, window)
		if allowed {
			c.Next()
			return
		}

		seconds := int(retryAfter.Seconds())
		if seconds < 1 {
			seconds = 1
		}
		c.Header("Retry-After", strconv.Itoa(seconds))
		AbortProblem(c, apperr.RateLimited().WithRequestID(RequestIDFrom(c)))
	}
}
