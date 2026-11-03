package analytics

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Service implements the analytics use cases.
type Service struct {
	repo Repository
	now  func() time.Time

	// mu guards seen, the in-process duplicate visit table.
	mu sync.Mutex
	// seen maps a visit key to the minute bucket it was last accepted in. It is per
	// process only: a second replica keeps its own table, so dedupe is best effort.
	seen map[string]time.Time
}

// ServiceConfig configures a Service.
type ServiceConfig struct {
	// Repository is required.
	Repository Repository
	// Now overrides the clock in tests.
	Now func() time.Time
}

// NewService builds a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Repository == nil {
		return nil, ErrInvalidInput
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{repo: cfg.Repository, now: now, seen: make(map[string]time.Time)}, nil
}

// Record stores one page view for a site.
//
// It has no authorization check by design: the write endpoint is anonymous, and the
// site is the one the host resolver picked, never a value from the request body. The
// handler additionally refuses anonymous writes to a members-only site.
//
// Repeated views of the same path by the same session inside one minute are dropped
// in process to keep a reload loop or a trivial script from inflating the report.
// The table is not shared between replicas and is bounded; it is a noise filter, not
// an authorization or rate limiting mechanism.
func (s *Service) Record(ctx context.Context, siteID string, in VisitInput) error {
	if strings.TrimSpace(siteID) == "" {
		return ErrInvalidInput
	}

	validated, err := ValidateVisit(in)
	if err != nil {
		return err
	}

	now := s.now().UTC()
	if s.isDuplicateVisit(siteID, validated, now) {
		return nil
	}

	return s.repo.Insert(ctx, Visit{
		SiteID:    siteID,
		Path:      validated.Path,
		Title:     validated.Title,
		Referrer:  validated.Referrer,
		Session:   validated.Session,
		Surface:   validated.Surface,
		CreatedAt: now,
	})
}

// isDuplicateVisit reports whether this view was already accepted in the current
// one minute window, recording it otherwise.
//
// The key is scoped by site so two tenants cannot suppress each other's traffic, and
// it intentionally excludes title and referrer: a page view is identified by who
// browsed what path.
func (s *Service) isDuplicateVisit(siteID string, in VisitInput, now time.Time) bool {
	key := siteID + "\x00" + in.Session + "\x00" + in.Path
	bucket := now.Truncate(DuplicateVisitWindow)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen == nil {
		s.seen = make(map[string]time.Time)
	}
	if last, ok := s.seen[key]; ok && last.Equal(bucket) {
		return true
	}
	if len(s.seen) >= MaxTrackedVisitKeys {
		s.pruneVisitKeysLocked(bucket)
	}
	s.seen[key] = bucket
	return false
}

// pruneVisitKeysLocked drops keys from older windows and, if the table is still full
// of distinct keys from the same window, resets it. Resetting can let a duplicate
// through once, which is fine: the table exists to bound noise and memory, not to be
// an exact set.
func (s *Service) pruneVisitKeysLocked(current time.Time) {
	cutoff := current.Add(-DuplicateVisitWindow)
	for key, bucket := range s.seen {
		if bucket.Before(cutoff) {
			delete(s.seen, key)
		}
	}
	if len(s.seen) >= MaxTrackedVisitKeys {
		s.seen = make(map[string]time.Time)
	}
}

// Report builds the dashboard payload for one site and range.
//
// Authorization lives here, not in the handler, so every future caller inherits it:
// the caller must be authenticated, act on its own site, and hold at least site
// administrator authority. A platform administrator is allowed because that role
// outranks site administrator.
func (s *Service) Report(
	ctx context.Context,
	actor Actor,
	siteID string,
	rangeValue Range,
	utcOffsetMinutes ...int,
) (Report, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return Report{}, ErrPermissionDenied
	}
	if actor.SiteID != siteID {
		return Report{}, ErrCrossSite
	}
	if !actor.Role.AtLeast(site.RoleSiteAdmin) {
		return Report{}, ErrPermissionDenied
	}
	if rangeValue == "" {
		rangeValue = Range24h
	}
	if !rangeValue.Valid() {
		return Report{}, ErrInvalidInput
	}

	offset := 0
	if len(utcOffsetMinutes) > 0 {
		offset = utcOffsetMinutes[0]
	}
	if offset < -14*60 || offset > 14*60 {
		return Report{}, ErrInvalidInput
	}
	zone := time.UTC
	if offset != 0 {
		zone = time.FixedZone("client", offset*60)
	}

	now := s.now().In(zone)
	window := rangeValue.Window(now)

	aggregate, err := s.repo.Aggregate(ctx, Query{
		SiteID:      siteID,
		Start:       window.Start,
		End:         now,
		OnlineSince: now.Add(-OnlineWindow).UTC(),
	})
	if err != nil {
		return Report{}, err
	}

	counts := make([]int, len(window.Labels))
	for _, at := range aggregate.Timestamps {
		if index, ok := window.Index(at); ok {
			counts[index]++
		}
	}
	series := make([]Point, len(window.Labels))
	for index, label := range window.Labels {
		series[index] = Point{Label: label, Count: counts[index]}
	}

	return Report{
		Range:      rangeValue,
		Totals:     Totals{Views: aggregate.Views, Sessions: aggregate.Sessions, Online: aggregate.Online},
		Series:     series,
		TopPages:   topPages(aggregate.PageCounts, MaxTopPages),
		TopContent: topContent(aggregate.PageCounts, MaxTopContent),
		Recent:     aggregate.Recent,
	}, nil
}

// topPages ranks paths by views, breaking ties by path so the response is stable.
func topPages(counts []TopPage, limit int) []TopPage {
	pages := make([]TopPage, len(counts))
	copy(pages, counts)
	sort.Slice(pages, func(i, j int) bool {
		if pages[i].Count != pages[j].Count {
			return pages[i].Count > pages[j].Count
		}
		return pages[i].Path < pages[j].Path
	})
	if len(pages) > limit {
		pages = pages[:limit]
	}
	if pages == nil {
		pages = []TopPage{}
	}
	return pages
}

// topContent attributes page views to content detail paths and ranks the result.
func topContent(counts []TopPage, limit int) []TopContent {
	byContent := make(map[string]int, len(counts))
	for _, page := range counts {
		if id, ok := ContentIDFromPath(page.Path); ok {
			byContent[id] += page.Count
		}
	}

	ranking := make([]TopContent, 0, len(byContent))
	for id, count := range byContent {
		ranking = append(ranking, TopContent{ID: id, Count: count})
	}
	sort.Slice(ranking, func(i, j int) bool {
		if ranking[i].Count != ranking[j].Count {
			return ranking[i].Count > ranking[j].Count
		}
		return ranking[i].ID < ranking[j].ID
	})
	if len(ranking) > limit {
		ranking = ranking[:limit]
	}
	return ranking
}
