// Package analyticsstore implements the analytics persistence port with Ent.
package analyticsstore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/analytics"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/pageview"
)

// Store is the Ent backed implementation of analytics.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ analytics.Repository = (*Store)(nil)

// Insert stores one immutable page view.
func (s *Store) Insert(ctx context.Context, visit analytics.Visit) error {
	at := visit.CreatedAt
	if at.IsZero() {
		at = time.Now().UTC()
	}

	_, err := s.client.PageView.Create().
		SetSiteID(visit.SiteID).
		SetPath(visit.Path).
		SetTitle(visit.Title).
		SetReferrer(visit.Referrer).
		SetSession(visit.Session).
		SetSurface(string(visit.Surface)).
		SetCreatedAt(at).
		Save(ctx)
	return err
}

// Aggregate computes the counts of one report window.
//
// Only the public surface is counted. Instead of dialect specific date functions for
// the buckets, the created_at column of the window is read and bucketed in Go; the
// query is still indexed by (site_id, surface, created_at), and it keeps the report
// identical on SQLite, MySQL and PostgreSQL.
func (s *Store) Aggregate(ctx context.Context, query analytics.Query) (analytics.Aggregate, error) {
	base := func() *entgen.PageViewQuery {
		built := s.client.PageView.Query().Where(
			pageview.SiteIDEQ(query.SiteID),
			pageview.SurfaceEQ(string(analytics.SurfaceSite)),
			pageview.CreatedAtGTE(query.Start),
		)
		if !query.End.IsZero() {
			built = built.Where(pageview.CreatedAtLTE(query.End))
		}
		return built
	}

	timestamps, err := viewTimestamps(ctx, base())
	if err != nil {
		return analytics.Aggregate{}, err
	}

	sessions, err := distinctSessions(ctx, base())
	if err != nil {
		return analytics.Aggregate{}, err
	}

	online, err := distinctSessions(ctx, base().Where(pageview.CreatedAtGTE(query.OnlineSince)))
	if err != nil {
		return analytics.Aggregate{}, err
	}

	pages, err := pageCounts(ctx, base())
	if err != nil {
		return analytics.Aggregate{}, err
	}

	recent, err := recentVisits(ctx, base())
	if err != nil {
		return analytics.Aggregate{}, err
	}

	return analytics.Aggregate{
		Views:      len(timestamps),
		Sessions:   sessions,
		Online:     online,
		Timestamps: timestamps,
		PageCounts: pages,
		Recent:     recent,
	}, nil
}

// recentVisits returns the latest public page views of the report window.
func recentVisits(ctx context.Context, query *entgen.PageViewQuery) ([]analytics.RecentVisit, error) {
	rows, err := query.
		Order(entgen.Desc(pageview.FieldCreatedAt)).
		Limit(10).
		All(ctx)
	if err != nil {
		return nil, err
	}

	recent := make([]analytics.RecentVisit, 0, len(rows))
	for _, row := range rows {
		recent = append(recent, analytics.RecentVisit{
			Path:      row.Path,
			Title:     row.Title,
			Referrer:  row.Referrer,
			Session:   row.Session,
			CreatedAt: row.CreatedAt,
		})
	}
	return recent, nil
}
func viewTimestamps(ctx context.Context, query *entgen.PageViewQuery) ([]time.Time, error) {
	var rows []struct {
		CreatedAt time.Time `json:"created_at"`
	}
	if err := query.Select(pageview.FieldCreatedAt).Scan(ctx, &rows); err != nil {
		return nil, err
	}

	timestamps := make([]time.Time, 0, len(rows))
	for _, row := range rows {
		timestamps = append(timestamps, row.CreatedAt)
	}
	return timestamps, nil
}

// distinctSessions counts unique session identifiers by grouping on the column.
//
// Counting distinct in SQL would need a dialect specific function; grouping is
// portable and the number of distinct sessions of one site is small.
func distinctSessions(ctx context.Context, query *entgen.PageViewQuery) (int, error) {
	var rows []struct {
		Session string `json:"session"`
		Count   int    `json:"count"`
	}
	if err := query.
		GroupBy(pageview.FieldSession).
		Aggregate(entgen.Count()).
		Scan(ctx, &rows); err != nil {
		return 0, err
	}
	return len(rows), nil
}

// pageCounts returns one row per distinct path in the window.
func pageCounts(ctx context.Context, query *entgen.PageViewQuery) ([]analytics.TopPage, error) {
	var rows []struct {
		Path  string `json:"path"`
		Count int    `json:"count"`
	}
	if err := query.
		GroupBy(pageview.FieldPath).
		Aggregate(entgen.Count()).
		Scan(ctx, &rows); err != nil {
		return nil, err
	}

	pages := make([]analytics.TopPage, 0, len(rows))
	for _, row := range rows {
		pages = append(pages, analytics.TopPage{Path: row.Path, Count: row.Count})
	}
	return pages, nil
}
