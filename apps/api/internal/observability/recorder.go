// Package observability owns the process local operational signals the admin
// panel reads. Today that is one thing: a bounded request log ring buffer.
//
// The buffer is deliberately not a second audit ledger. It is a debugging aid
// that answers "what did this process just serve", so it is:
//
//   - bounded: only the newest Capacity entries are kept and the oldest one is
//     overwritten, which keeps the memory cost of a long running process flat;
//   - metadata only: request body, headers, cookies and the query string are
//     never read into it. The page that renders this buffer is reachable by a
//     site administrator, so a leak here would leak credentials and visitor
//     data, not just operational detail;
//   - in memory only: it disappears on restart by design. Durable history
//     belongs in audit_logs, which has its own retention policy.
//
// The package is transport adjacent but not transport owned: the composition
// root mounts Middleware on the gin engine and passes this same Recorder to the
// /system/logs handler, so the writer and the reader always agree on one ring.
package observability

import (
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// Capacity is the documented ring size (Beta 1.2 contract K).
const Capacity = 500

// Bounds on what one entry may store. They stop a hostile or buggy request from
// growing a single ring slot without bound, which matters because the ring is
// shared by every request of the process.
const (
	// MaxPathLength matches the longest route template the router registers.
	MaxPathLength = 512
	// MaxRequestIDLength mirrors the correlation id middleware's own bound.
	MaxRequestIDLength = 64
	// MaxMethodLength bounds the HTTP verb; real verbs are far shorter.
	MaxMethodLength = 16
)

// Entry is one recorded request. The JSON field names are the frozen contract
// of the log viewer.
type Entry struct {
	Time       time.Time `json:"time"`
	RequestID  string    `json:"request_id"`
	Method     string    `json:"method"`
	Path       string    `json:"path"`
	Status     int       `json:"status"`
	DurationMS int64     `json:"duration_ms"`
	SiteID     string    `json:"site_id"`
	UserID     string    `json:"user_id"`
}

// Filter narrows a read of the ring. Zero fields are not applied.
//
// SiteID is not a query parameter of the endpoint; the handler fills it from the
// caller's principal so a site administrator cannot read another site's request
// metadata.
type Filter struct {
	Limit  int
	Status int
	Method string
	Path   string
	SiteID string
}

// matches reports whether entry satisfies the filter. The caller already holds
// the lock.
func (f Filter) matches(entry Entry) bool {
	if f.Status != 0 && entry.Status != f.Status {
		return false
	}
	if f.Method != "" && !strings.EqualFold(entry.Method, f.Method) {
		return false
	}
	if f.Path != "" && !strings.Contains(strings.ToLower(entry.Path), strings.ToLower(f.Path)) {
		return false
	}
	if f.SiteID != "" && entry.SiteID != f.SiteID {
		return false
	}
	return true
}

// Recorder is a fixed size, concurrency safe ring of request metadata.
//
// Append and List are safe for concurrent use; the ring's zero value is not
// usable, build one with NewRecorder.
type Recorder struct {
	mu       sync.Mutex
	entries  []Entry
	head     int // index the next append writes
	count    int
	capacity int
}

// NewRecorder builds the documented 500 entry recorder.
func NewRecorder() *Recorder { return NewRecorderWithCapacity(Capacity) }

// NewRecorderWithCapacity builds a recorder with an explicit size. A capacity
// below one falls back to Capacity. It exists for tests and for a future
// deployment knob; production uses NewRecorder.
func NewRecorderWithCapacity(capacity int) *Recorder {
	if capacity <= 0 {
		capacity = Capacity
	}
	return &Recorder{
		entries:  make([]Entry, capacity),
		capacity: capacity,
	}
}

// Capacity reports how many entries the ring holds, so the handler can bound a
// caller supplied limit without guessing.
func (r *Recorder) Capacity() int {
	if r == nil {
		return 0
	}
	return r.capacity
}

// Len reports how many entries are currently stored.
func (r *Recorder) Len() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.count
}

// Append records one entry, overwriting the oldest one when the ring is full.
//
// The entry is normalised here rather than in the middleware so every writer
// (middleware, tests, a future background job) produces the same bounded,
// UTC-stamped, query-free row.
func (r *Recorder) Append(entry Entry) {
	if r == nil {
		return
	}
	normalized := normalizeEntry(entry)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[r.head] = normalized
	r.head = (r.head + 1) % r.capacity
	if r.count < r.capacity {
		r.count++
	}
}

// List returns the matching entries, newest first, at most Limit of them.
//
// Newest first is what the panel renders and what makes a status code trend
// readable; a finite scan of the ring is cheap enough to filter inline.
func (r *Recorder) List(filter Filter) []Entry {
	if r == nil {
		return []Entry{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	limit := filter.Limit
	if limit <= 0 || limit > r.capacity {
		limit = r.capacity
	}
	out := make([]Entry, 0, min(limit, r.count))
	for offset := 1; offset <= r.count && len(out) < limit; offset++ {
		index := (r.head - offset + r.capacity) % r.capacity
		entry := r.entries[index]
		if !filter.matches(entry) {
			continue
		}
		out = append(out, entry)
	}
	return out
}

// normalizeEntry bounds and stamps one entry. An entry without a time is
// stamped now so a caller that forgets one cannot produce a zero row.
func normalizeEntry(entry Entry) Entry {
	if entry.Time.IsZero() {
		entry.Time = time.Now().UTC()
	} else {
		entry.Time = entry.Time.UTC()
	}
	entry.RequestID = truncate(entry.RequestID, MaxRequestIDLength)
	entry.Method = truncate(strings.ToUpper(strings.TrimSpace(entry.Method)), MaxMethodLength)
	entry.Path = truncate(entry.Path, MaxPathLength)
	entry.SiteID = truncate(entry.SiteID, 36)
	entry.UserID = truncate(entry.UserID, 36)
	if entry.Status < 0 {
		entry.Status = 0
	}
	if entry.DurationMS < 0 {
		entry.DurationMS = 0
	}
	return entry
}

// truncate cuts value to at most limit runes without splitting one.
func truncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// MiddlewareConfig overrides how the middleware resolves request context.
//
// It is optional: the defaults read the transport middleware's request id, the
// resolved site and the authenticated principal, which is what a production
// mount needs. Tests supply explicit readers so they need neither a token issuer
// nor a site resolver.
type MiddlewareConfig struct {
	// Now is the clock used for the entry timestamp and duration.
	Now func() time.Time
	// RequestID returns the correlation id for the request.
	RequestID func(*gin.Context) string
	// SiteID returns the site the request was resolved for.
	SiteID func(*gin.Context) string
	// UserID returns the authenticated user, or empty for anonymous traffic.
	UserID func(*gin.Context) string
}

// Middleware returns the gin middleware that records every request.
//
// Mount it on the engine immediately after the request id middleware and before
// the error handler: the middleware calls c.Next(), and only a registration
// earlier than the error handler observes the final status that handler wrote.
// The site and user are read after c.Next() on purpose, because both are set by
// middlewares that run inside the request chain.
func (r *Recorder) Middleware(config ...MiddlewareConfig) gin.HandlerFunc {
	resolved := defaultMiddlewareConfig()
	if len(config) > 0 {
		resolved = mergeMiddlewareConfig(resolved, config[0])
	}
	return func(c *gin.Context) {
		if r == nil {
			c.Next()
			return
		}
		start := resolved.Now()
		c.Next()

		path := c.FullPath()
		if path == "" {
			// No route matched: the template is empty, so the raw path is the only
			// honest value. It still excludes the query string.
			path = c.Request.URL.Path
		}
		r.Append(Entry{
			Time:       start,
			RequestID:  resolved.RequestID(c),
			Method:     c.Request.Method,
			Path:       path,
			Status:     c.Writer.Status(),
			DurationMS: resolved.Now().Sub(start).Milliseconds(),
			SiteID:     resolved.SiteID(c),
			UserID:     resolved.UserID(c),
		})
	}
}

// defaultMiddlewareConfig reads the context the transport middlewares populate.
func defaultMiddlewareConfig() MiddlewareConfig {
	return MiddlewareConfig{
		Now:       func() time.Time { return time.Now().UTC() },
		RequestID: middleware.RequestIDFrom,
		SiteID: func(c *gin.Context) string {
			resolved, ok := middleware.SiteFrom(c)
			if !ok {
				return ""
			}
			return resolved.ID
		},
		UserID: func(c *gin.Context) string {
			principal, ok := middleware.PrincipalFrom(c)
			if !ok {
				return ""
			}
			return principal.UserID
		},
	}
}

// mergeMiddlewareConfig applies the non-nil overrides on top of base.
func mergeMiddlewareConfig(base, override MiddlewareConfig) MiddlewareConfig {
	if override.Now != nil {
		base.Now = override.Now
	}
	if override.RequestID != nil {
		base.RequestID = override.RequestID
	}
	if override.SiteID != nil {
		base.SiteID = override.SiteID
	}
	if override.UserID != nil {
		base.UserID = override.UserID
	}
	return base
}
