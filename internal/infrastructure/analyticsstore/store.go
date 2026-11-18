// Package analyticsstore implements the analytics persistence port with Ent.
package analyticsstore

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/analytics"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/pageview"
)

// Store is the Ent backed implementation of analytics.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ analytics.Repository = (*Store)(nil)

// Insert stores one immutable page view.
//
// The derived columns are normalized here as a last line of defence: the service
// already fills them, but a row that fails the storage enum would drop an otherwise
// valid visit, and losing traffic data over a classification bug is worse than
// recording it as unknown.
func (s *Store) Insert(ctx context.Context, visit analytics.Visit) error {
	at := visit.CreatedAt
	if at.IsZero() {
		at = time.Now().UTC()
	}

	source := visit.Source
	if !source.Valid() {
		source = analytics.SourceUnknown
	}
	device := visit.Device
	if !device.Valid() {
		device = analytics.DeviceUnknown
	}
	referrerHost := visit.ReferrerHost
	if len(referrerHost) > analytics.MaxReferrerHostLength {
		referrerHost = referrerHost[:analytics.MaxReferrerHostLength]
	}

	_, err := s.client.PageView.Create().
		SetSiteID(visit.SiteID).
		SetPath(visit.Path).
		SetTitle(visit.Title).
		SetReferrer(visit.Referrer).
		SetReferrerHost(referrerHost).
		SetSource(string(source)).
		SetDevice(string(device)).
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

	sessionVisits, timestamps, err := viewRows(ctx, base())
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

	sources, err := sourceCounts(ctx, base())
	if err != nil {
		return analytics.Aggregate{}, err
	}

	devices, err := deviceCounts(ctx, base())
	if err != nil {
		return analytics.Aggregate{}, err
	}

	referrers, err := referrerCounts(ctx, base())
	if err != nil {
		return analytics.Aggregate{}, err
	}

	firstSeen, err := firstSeenSessions(ctx, s.historyQuery(query))
	if err != nil {
		return analytics.Aggregate{}, err
	}

	return analytics.Aggregate{
		Views:            len(timestamps),
		Sessions:         distinctSessionCount(sessionVisits),
		Online:           online,
		Timestamps:       timestamps,
		PageCounts:       pages,
		Recent:           recent,
		SourceCounts:     sources,
		DeviceCounts:     devices,
		ReferrerCounts:   referrers,
		SessionVisits:    sessionVisits,
		SessionFirstSeen: firstSeen,
	}, nil
}

// historyQuery selects the public traffic of the site up to the report clock without
// a lower bound, because the first appearance of a session may predate the window.
func (s *Store) historyQuery(query analytics.Query) *entgen.PageViewQuery {
	built := s.client.PageView.Query().Where(
		pageview.SiteIDEQ(query.SiteID),
		pageview.SurfaceEQ(string(analytics.SurfaceSite)),
	)
	if !query.End.IsZero() {
		built = built.Where(pageview.CreatedAtLTE(query.End))
	}
	return built
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

// viewRows returns the session marks and timestamps of the window in one scan.
//
// The report needs both the hourly series and which session was seen when; reading
// session together with created_at avoids scanning the same window twice.
func viewRows(ctx context.Context, query *entgen.PageViewQuery) ([]analytics.SessionVisit, []time.Time, error) {
	var rows []struct {
		Session   string    `json:"session"`
		CreatedAt time.Time `json:"created_at"`
	}
	if err := query.Select(pageview.FieldSession, pageview.FieldCreatedAt).Scan(ctx, &rows); err != nil {
		return nil, nil, err
	}

	visits := make([]analytics.SessionVisit, 0, len(rows))
	timestamps := make([]time.Time, 0, len(rows))
	for _, row := range rows {
		visits = append(visits, analytics.SessionVisit{Session: row.Session, At: row.CreatedAt})
		timestamps = append(timestamps, row.CreatedAt)
	}
	return visits, timestamps, nil
}

// distinctSessionCount counts the unique sessions of a set of views in Go. The rows
// are already loaded for the series, so this costs a map instead of another query.
func distinctSessionCount(visits []analytics.SessionVisit) int {
	unique := make(map[string]struct{}, len(visits))
	for _, visit := range visits {
		unique[visit.Session] = struct{}{}
	}
	return len(unique)
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

// sourceCounts groups the window by source and session.
//
// One grouped query yields both numbers of the breakdown: the sum of the group counts
// is the visit count of the source, and the number of groups is its distinct session
// count (a session may contribute one group per source, which is intended).
func sourceCounts(ctx context.Context, query *entgen.PageViewQuery) ([]analytics.SourceCount, error) {
	var rows []struct {
		Source  string `json:"source"`
		Session string `json:"session"`
		Count   int    `json:"count"`
	}
	if err := query.
		GroupBy(pageview.FieldSource, pageview.FieldSession).
		Aggregate(entgen.Count()).
		Scan(ctx, &rows); err != nil {
		return nil, err
	}

	bySource := make(map[string]*analytics.SourceCount, len(rows))
	order := make([]string, 0, len(rows))
	for _, row := range rows {
		count, ok := bySource[row.Source]
		if !ok {
			count = &analytics.SourceCount{Source: analytics.Source(row.Source)}
			bySource[row.Source] = count
			order = append(order, row.Source)
		}
		count.Visits += row.Count
		count.Sessions++
	}

	counts := make([]analytics.SourceCount, 0, len(order))
	for _, source := range order {
		counts = append(counts, *bySource[source])
	}
	return counts, nil
}

// deviceCounts groups the window by device and session; see sourceCounts for why one
// grouped query produces both the visit and the session numbers.
func deviceCounts(ctx context.Context, query *entgen.PageViewQuery) ([]analytics.DeviceCount, error) {
	var rows []struct {
		Device  string `json:"device"`
		Session string `json:"session"`
		Count   int    `json:"count"`
	}
	if err := query.
		GroupBy(pageview.FieldDevice, pageview.FieldSession).
		Aggregate(entgen.Count()).
		Scan(ctx, &rows); err != nil {
		return nil, err
	}

	byDevice := make(map[string]*analytics.DeviceCount, len(rows))
	order := make([]string, 0, len(rows))
	for _, row := range rows {
		count, ok := byDevice[row.Device]
		if !ok {
			count = &analytics.DeviceCount{Device: analytics.Device(row.Device)}
			byDevice[row.Device] = count
			order = append(order, row.Device)
		}
		count.Visits += row.Count
		count.Sessions++
	}

	counts := make([]analytics.DeviceCount, 0, len(order))
	for _, device := range order {
		counts = append(counts, *byDevice[device])
	}
	return counts, nil
}

// referrerCounts returns one row per external referrer host in the window.
//
// Internal navigation stores an empty host on purpose, so it is filtered out here
// rather than ranked as if it were an outside link.
func referrerCounts(ctx context.Context, query *entgen.PageViewQuery) ([]analytics.ReferrerCount, error) {
	var rows []struct {
		ReferrerHost string `json:"referrer_host"`
		Count        int    `json:"count"`
	}
	if err := query.
		Where(pageview.ReferrerHostNEQ("")).
		GroupBy(pageview.FieldReferrerHost).
		Aggregate(entgen.Count()).
		Scan(ctx, &rows); err != nil {
		return nil, err
	}

	counts := make([]analytics.ReferrerCount, 0, len(rows))
	for _, row := range rows {
		counts = append(counts, analytics.ReferrerCount{Host: row.ReferrerHost, Visits: row.Count})
	}
	return counts, nil
}

// firstSeenSessions returns the earliest public page view of every session known to
// the site up to the report clock.
//
// This is the second half of the retention query pair: the window scan knows which
// sessions were active on which day, and this projection knows whether a session had
// appeared before. It is deliberately not bounded by the window start, but grouping
// on the (site_id, session, created_at) index keeps it one grouped scan instead of a
// query per session.
func firstSeenSessions(ctx context.Context, query *entgen.PageViewQuery) ([]analytics.SessionFirstSeen, error) {
	// The aggregate column has no declared type, so SQLite hands back the raw text
	// it stored while MySQL and PostgreSQL hand back a time.Time. Scanning into any
	// and normalizing keeps one code path for all three dialects.
	var rows []struct {
		Session string `json:"session"`
		FirstAt any    `json:"first_at"`
	}
	if err := query.
		GroupBy(pageview.FieldSession).
		Aggregate(entgen.As(entgen.Min(pageview.FieldCreatedAt), "first_at")).
		Scan(ctx, &rows); err != nil {
		return nil, err
	}

	firstSeen := make([]analytics.SessionFirstSeen, 0, len(rows))
	for _, row := range rows {
		firstAt, err := aggregateTime(row.FirstAt)
		if err != nil {
			return nil, err
		}
		firstSeen = append(firstSeen, analytics.SessionFirstSeen{
			Session: row.Session,
			FirstAt: firstAt,
		})
	}
	return firstSeen, nil
}

// aggregateTimeLayouts cover the text encodings the drivers may return for an
// aggregate over a timestamp column.
var aggregateTimeLayouts = []string{
	time.RFC3339Nano,
	// time.Time.String(), which the pure Go SQLite driver stores by default.
	"2006-01-02 15:04:05.999999999 -0700 MST",
	"2006-01-02 15:04:05.999999999-07:00",
	"2006-01-02T15:04:05.999999999-07:00",
	"2006-01-02 15:04:05.999999999",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

// aggregateTime normalizes the value of MIN(created_at) to time.Time.
func aggregateTime(value any) (time.Time, error) {
	switch typed := value.(type) {
	case nil:
		return time.Time{}, nil
	case time.Time:
		return typed, nil
	case string:
		return parseAggregateTime(typed)
	case []byte:
		return parseAggregateTime(string(typed))
	case int64:
		// An integer time format is opt-in on the SQLite connection; accept it so a
		// deployment that enabled it does not lose retention data.
		return time.Unix(typed, 0).UTC(), nil
	default:
		return time.Time{}, fmt.Errorf("analyticsstore: unsupported aggregate time value %T", value)
	}
}

// parseAggregateTime parses the text encodings listed in aggregateTimeLayouts.
func parseAggregateTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	for _, layout := range aggregateTimeLayouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("analyticsstore: unsupported aggregate time value %q", value)
}
