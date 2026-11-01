package analytics

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Service implements the analytics use cases.
type Service struct {
	repo Repository
	now  func() time.Time
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
	return &Service{repo: cfg.Repository, now: now}, nil
}

// Record stores one page view for a site.
//
// It has no authorization check by design: the write endpoint is anonymous, and the
// site is the one the host resolver picked, never a value from the request body.
func (s *Service) Record(ctx context.Context, siteID string, in VisitInput) error {
	if strings.TrimSpace(siteID) == "" {
		return ErrInvalidInput
	}

	validated, err := ValidateVisit(in)
	if err != nil {
		return err
	}

	return s.repo.Insert(ctx, Visit{
		SiteID:    siteID,
		Path:      validated.Path,
		Title:     validated.Title,
		Referrer:  validated.Referrer,
		Session:   validated.Session,
		Surface:   validated.Surface,
		CreatedAt: s.now().UTC(),
	})
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
