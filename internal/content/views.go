package content

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

// Single item read counting and the "popular" leaderboard (FSD A-16 / B-20, plan
// P0-06).
//
// The counter answers exactly one question: how many readers opened this item. It is
// deliberately not derived from the analytics page_view ledger:
//
//   - page_view is the traffic ledger. The browser writes it for every surface
//     (including the admin) from an opaque path, so it can be forged and it cannot
//     tell a detail page from a listing that merely links to one. It stays the only
//     source of the traffic series, the top pages list and the online count.
//   - view_count is written by the server when it actually serves a *published* item
//     to a reader. It is per item, it is already de-duplicated when written, and it
//     can be read on the list path without a second query.
//
// The two therefore never count the same read twice: the visit endpoint does not
// touch content_items, and this counter never writes a page_view row. A reader who
// opens an article produces one page view and at most one counted view.
//
// Consistency: the increment is one `UPDATE ... SET view_count = view_count + 1`
// issued after the response body has been rendered. It is a small write by primary
// key, it never touches another column (so it cannot lose an editor's save), and a
// failure is reported as "not counted" rather than as a failed read. The number a
// reader sees on the page they just opened is therefore the count *before* their own
// read; the next request sees it. The count is monotonic but not transactional with
// the read: a crash between the response and the update loses one view, which is the
// trade we want (a read must never fail because a counter did).

// Bounds of the read counter.
const (
	// ViewDedupeWindow is how long one reader counts at most once per item. It is
	// long enough that a reload loop, a back/forward walk or a second tab opened
	// from the same page adds nothing, and short enough that a returning reader the
	// next day counts again.
	ViewDedupeWindow = 30 * time.Minute
	// MaxTrackedViewKeys bounds the in-process de-duplication table so a flood of
	// distinct sessions cannot grow it without bound.
	MaxTrackedViewKeys = 8192
	// maxViewSessionLength mirrors the browser session id bound the analytics visit
	// endpoint accepts; a longer header is truncated instead of rejected because a
	// view must never fail on its de-duplication hint.
	maxViewSessionLength = 64
)

// ViewInput is one read of a published item, as the HTTP layer observed it.
//
// It carries no content payload: the service only needs to know which item was read,
// by which reader, and whether that reader is its own author.
type ViewInput struct {
	SiteID    string
	ContentID string
	// UserID is the signed-in reader; empty for an anonymous visitor.
	UserID string
	// Session is the anonymous browser session identifier the reader's client sent.
	// It is a random client value, not a credential.
	Session string
	// IP is the resolved client address, used as the last identity resort.
	IP string
	// SelfView marks a read by the item's own author or by an editor. Those are
	// never counted: the author refreshing the page, or an editor opening the item
	// in the admin editor, is not a reader, and self inflation would make the number
	// meaningless.
	SelfView bool
}

// viewKey returns the de-duplication key of one read.
//
// The identity order is deliberate: an account is the strongest identity (it
// survives a browser change), then the browser session the client reports, then the
// resolved address. A caller that supplies nothing at all is collapsed into one
// shared anonymous key, which can only under-count: at most one view of that item is
// counted per window when the server cannot tell readers apart.
//
// This is a noise filter, not a security boundary: a script can rotate sessions or
// addresses. The real bounds on anonymous traffic are the request rate limiter and
// the fact that only published items are counted at all.
func viewKey(in ViewInput) string {
	viewer := "anon"
	switch {
	case strings.TrimSpace(in.UserID) != "":
		viewer = "u:" + strings.TrimSpace(in.UserID)
	case strings.TrimSpace(in.Session) != "":
		session := strings.TrimSpace(in.Session)
		if len(session) > maxViewSessionLength {
			session = session[:maxViewSessionLength]
		}
		viewer = "s:" + session
	case strings.TrimSpace(in.IP) != "":
		viewer = "ip:" + strings.TrimSpace(in.IP)
	}
	return in.SiteID + "\x00" + in.ContentID + "\x00" + viewer
}

// viewGate is the bounded, process-local de-duplication table of the read counter.
//
// It mirrors analytics.Service: a per process table, a window rather than an exact
// ledger, and a hard cap that is pruned (and finally reset) instead of growing. A
// second replica keeps its own table, so a read can be counted once per replica; the
// alternative - a durable per-reader ledger - would put a second write on the read
// path for every visitor, which is exactly the cost this design avoids.
type viewGate struct {
	mu     sync.Mutex
	seen   map[string]time.Time
	now    func() time.Time
	window time.Duration
	max    int
}

// newViewGate builds an empty gate.
func newViewGate(now func() time.Time, window time.Duration, max int) *viewGate {
	return &viewGate{seen: make(map[string]time.Time), now: now, window: window, max: max}
}

// allow reports whether this key has not been seen inside the current window and
// records it. It is safe for concurrent use, so two simultaneous requests for the
// same item by the same reader count once.
func (g *viewGate) allow(key string) bool {
	if key == "" {
		return false
	}
	now := g.now().UTC()

	g.mu.Lock()
	defer g.mu.Unlock()
	if last, ok := g.seen[key]; ok && now.Sub(last) < g.window {
		return false
	}
	if len(g.seen) >= g.max {
		g.pruneLocked(now)
	}
	g.seen[key] = now
	return true
}

// pruneLocked drops expired keys. If the table is still full - a burst of distinct
// readers inside one window - it is reset; that can let one duplicate through, which
// is acceptable for a counter whose job is to bound noise and memory.
func (g *viewGate) pruneLocked(now time.Time) {
	cutoff := now.Add(-g.window)
	for key, last := range g.seen {
		if last.Before(cutoff) {
			delete(g.seen, key)
		}
	}
	if len(g.seen) >= g.max {
		g.seen = make(map[string]time.Time)
	}
}

// RecordView counts one read of a published item.
//
// It is best effort by contract: it returns an error only so a test can assert the
// write happened, and the HTTP layer deliberately ignores the result. A read must
// never fail because its counter could not be written.
//
// Exactly one call per served request is the caller's job; the de-duplication gate
// additionally collapses concurrent and repeated reads by the same reader.
func (s *Service) RecordView(ctx context.Context, in ViewInput) error {
	if in.SelfView {
		return nil
	}
	in.SiteID = strings.TrimSpace(in.SiteID)
	in.ContentID = strings.TrimSpace(in.ContentID)
	if in.SiteID == "" || in.ContentID == "" {
		return nil
	}
	if s.views == nil || !s.views.allow(viewKey(in)) {
		return nil
	}
	return s.repo.IncrementViewCount(ctx, in.SiteID, in.ContentID)
}

// Popular ranking windows.
const (
	// PopularWindow7d keeps only items published in the last week.
	PopularWindow7d = "7d"
	// PopularWindow30d is the default: a month is long enough for a small site to
	// accumulate signal and short enough that last year's hit does not own the list.
	PopularWindow30d = "30d"
	// PopularWindow90d is the quarterly view.
	PopularWindow90d = "90d"
	// DefaultPopularWindow applies when the caller omits the window.
	DefaultPopularWindow = PopularWindow30d
	// DefaultPopularLimit is the leaderboard size the reader surfaces ask for.
	DefaultPopularLimit = 8
	// MaxPopularLimit bounds one page of the leaderboard.
	MaxPopularLimit = 50
	// PopularGravity is the decay exponent of the ranking score. It matches the
	// classic "votes over age" curve: a 1.5 exponent lets a strong item stay on top
	// for a day or two and then yields to newer traffic.
	PopularGravity = 1.5
	// popularCandidateFactor and maxPopularCandidates bound how many rows the
	// repository hands to the in-process re-ranking. The repository orders by raw
	// view count, then the service applies the time decay to that short list. A
	// larger factor keeps a hot-but-slightly-older item from being cut before it is
	// scored; the cap keeps the sort bounded on a large site.
	popularCandidateFactor = 4
	maxPopularCandidates   = 200
)

// PopularWindowFor resolves a window name to its length.
func PopularWindowFor(name string) (time.Duration, bool) {
	switch strings.TrimSpace(name) {
	case PopularWindow7d:
		return 7 * 24 * time.Hour, true
	case "", PopularWindow30d:
		return 30 * 24 * time.Hour, true
	case PopularWindow90d:
		return 90 * 24 * time.Hour, true
	default:
		return 0, false
	}
}

// ParsePopularWindow validates a window query value, returning the canonical name.
//
// An empty value is the documented default rather than an error, so a client that
// sends no window gets the 30 day board. Any other value is refused: silently
// falling back would hide a typo behind a plausible looking leaderboard.
func ParsePopularWindow(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return DefaultPopularWindow, nil
	}
	if _, ok := PopularWindowFor(name); !ok {
		return "", fmt.Errorf("%w: unsupported popular window", ErrInvalidInput)
	}
	return name, nil
}

// PopularQuery is a caller supplied leaderboard request.
//
// Site and visibility are filled by the service, never by the caller: the board is a
// public reader surface, so it only ever ranks published public items even when an
// editor asks for it.
type PopularQuery struct {
	Kind       Kind
	CategoryID string
	Tag        string
	// Limit is the requested board size. Zero falls back to DefaultPopularLimit.
	Limit int
	// Window is the ranking horizon, already validated by ParsePopularWindow.
	Window string
}

// PopularFilter is the normalized query the repository executes.
//
// The repository orders the candidates by raw view count; the service then applies
// the time decay, because the decay is a policy decision that must stay testable
// without a database and portable across the three supported dialects.
type PopularFilter struct {
	SiteID     string
	Kind       Kind
	CategoryID string
	Tag        string
	// PublishedSince is the lower bound of the ranking horizon.
	PublishedSince time.Time
	Limit          int
}

// PopularItem is one row of the leaderboard: the item plus its decayed score.
type PopularItem struct {
	Content Content
	// Score is the decayed popularity. It is exported so tests and operators can see
	// why one item outranks another; the HTTP response only ranks by it.
	Score float64
}

// Popular returns the leaderboard of one site.
//
// Only published public items compete: password and members-only items are
// direct-link-only by design (C-18) and a leaderboard is the fastest way to leak
// them, so their access mode is excluded here rather than inherited from the caller.
func (s *Service) Popular(
	ctx context.Context,
	actor Actor,
	query PopularQuery,
) ([]PopularItem, error) {
	if strings.TrimSpace(actor.SiteID) == "" {
		return nil, ErrInvalidInput
	}
	if query.Kind != "" && !query.Kind.Valid() {
		return nil, ErrInvalidInput
	}

	categoryID := strings.TrimSpace(query.CategoryID)
	if len([]rune(categoryID)) > maxCategoryIDLength {
		return nil, fmt.Errorf("%w: category id is malformed", ErrInvalidInput)
	}

	tag := ""
	if raw := strings.TrimSpace(query.Tag); raw != "" {
		tag = NormalizeTag(raw)
		if tag == "" {
			return nil, fmt.Errorf("%w: tag is malformed", ErrInvalidInput)
		}
	}

	name, err := ParsePopularWindow(query.Window)
	if err != nil {
		return nil, err
	}
	window, _ := PopularWindowFor(name)

	limit := query.Limit
	if limit <= 0 {
		limit = DefaultPopularLimit
	}
	if limit > MaxPopularLimit {
		limit = MaxPopularLimit
	}
	candidates := limit * popularCandidateFactor
	if candidates > maxPopularCandidates {
		candidates = maxPopularCandidates
	}
	if candidates < limit {
		candidates = limit
	}

	now := s.now()
	items, err := s.repo.Popular(ctx, PopularFilter{
		SiteID:         actor.SiteID,
		Kind:           query.Kind,
		CategoryID:     categoryID,
		Tag:            tag,
		PublishedSince: now.Add(-window),
		Limit:          candidates,
	})
	if err != nil {
		return nil, err
	}

	ranked := RankPopular(items, now, limit)
	return ranked, nil
}

// RankPopular applies the time decay to a candidate list and returns the board.
//
// score = views / (hours_since_publish + 2)^gravity
//
// The +2 keeps a just published item from dividing by ~0 and ranks "published one
// hour ago" close to "published now". Items with no views score 0 and therefore fall
// through to the tie-breaker, which is publication date: a site with no traffic yet
// gets its newest items, which is the honest answer and the same fallback the reader
// surfaces used before this endpoint existed.
func RankPopular(items []Content, now time.Time, limit int) []PopularItem {
	ranked := make([]PopularItem, 0, len(items))
	for _, item := range items {
		ranked = append(ranked, PopularItem{Content: item, Score: popularScore(item, now)})
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		a, b := ranked[i], ranked[j]
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		if a.Content.ViewCount != b.Content.ViewCount {
			return a.Content.ViewCount > b.Content.ViewCount
		}
		at, bt := publishedTime(a.Content), publishedTime(b.Content)
		if !at.Equal(bt) {
			return at.After(bt)
		}
		return a.Content.ID < b.Content.ID
	})

	if limit > 0 && len(ranked) > limit {
		ranked = ranked[:limit]
	}
	return ranked
}

// popularScore is the decayed score of one item.
func popularScore(item Content, now time.Time) float64 {
	if item.ViewCount <= 0 || item.PublishedAt == nil {
		return 0
	}
	hours := now.Sub(*item.PublishedAt).Hours()
	if hours < 0 {
		// A scheduled item can be published a moment in the future from the caller's
		// clock skew; treat it as brand new instead of inflating its score.
		hours = 0
	}
	return float64(item.ViewCount) / math.Pow(hours+2, PopularGravity)
}

// publishedTime is the ordering timestamp of an item; zero when it has none.
func publishedTime(item Content) time.Time {
	if item.PublishedAt != nil {
		return *item.PublishedAt
	}
	return time.Time{}
}
