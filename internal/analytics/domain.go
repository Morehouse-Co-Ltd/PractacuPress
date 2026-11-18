// Package analytics records anonymous page views and produces the traffic report
// shown in the admin dashboard.
//
// Two rules shape the package. A visit is an immutable event, so writes are a single
// insert and never update. Reporting only ever counts the public surface ("site"):
// admin traffic would inflate the numbers readers care about, and the admin itself is
// not what the dashboard is meant to measure.
package analytics

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/site"
)

// Surface is where a page view happened.
type Surface string

// Supported surfaces.
const (
	SurfaceSite  Surface = "site"
	SurfaceAdmin Surface = "admin"
)

// Valid reports whether the surface is defined.
func (s Surface) Valid() bool { return s == SurfaceSite || s == SurfaceAdmin }

// Range is the reporting window.
type Range string

// Supported reporting windows.
const (
	Range24h Range = "24h"
	Range7d  Range = "7d"
	Range30d Range = "30d"
)

// Valid reports whether the range is defined.
func (r Range) Valid() bool { return r == Range24h || r == Range7d || r == Range30d }

// ParseRange reads the range query parameter. An empty value is the documented
// default so the dashboard can omit it on its first request.
func ParseRange(raw string) (Range, error) {
	switch Range(strings.TrimSpace(raw)) {
	case "":
		return Range24h, nil
	case Range24h, Range7d, Range30d:
		return Range(strings.TrimSpace(raw)), nil
	default:
		return "", ErrInvalidInput
	}
}

// Bounds on caller supplied visit fields.
const (
	// MaxPathLength bounds a recorded path.
	MaxPathLength = 2048
	// MaxTitleLength bounds a recorded title.
	MaxTitleLength = 300
	// MaxReferrerLength bounds a referrer.
	MaxReferrerLength = 2048
	// MaxSessionLength bounds the client session identifier.
	MaxSessionLength = 64
	// OnlineWindow is how recently a session must have been seen to count as online.
	OnlineWindow = 5 * time.Minute
	// MaxTopPages bounds the page leaderboard.
	MaxTopPages = 8
	// MaxTopContent bounds the content leaderboard.
	MaxTopContent = 8
	// DuplicateVisitWindow suppresses repeated writes of the same page view by the
	// same client session inside one process. It is a noise filter, not a security
	// boundary: replicas keep separate windows and an attacker can still rotate
	// sessions. The real limits on anonymous writes are rate limiting and the
	// members-only visibility gate.
	DuplicateVisitWindow = time.Minute
	// MaxTrackedVisitKeys bounds the in-process dedupe table so a flood of distinct
	// sessions cannot grow it without bound.
	MaxTrackedVisitKeys = 4096
)

// Sentinel errors.
var (
	// ErrInvalidInput means a visit field or the range failed validation.
	ErrInvalidInput = errors.New("analytics: invalid input")
	// ErrPermissionDenied means the caller may not read this site's analytics.
	ErrPermissionDenied = errors.New("analytics: permission denied")
	// ErrCrossSite means the site in the path is not the principal's site.
	ErrCrossSite = errors.New("analytics: cross site access")
	// ErrNotFound means no matching record exists.
	ErrNotFound = errors.New("analytics: not found")
)

// VisitInput is a page view report from the browser.
type VisitInput struct {
	Path     string
	Title    string
	Referrer string
	Session  string
	Surface  Surface
	// Signals are derived by the transport from the request headers. They are not
	// part of the request body and must never be trusted from it; the zero value is
	// normalized before storing so a direct service call still produces a valid row.
	Signals Signals
}

// Visit is a validated page view ready to store.
type Visit struct {
	SiteID       string
	Path         string
	Title        string
	Referrer     string
	ReferrerHost string
	Source       Source
	Device       Device
	Session      string
	Surface      Surface
	CreatedAt    time.Time
}

// ValidateVisit trims and bounds a page view report.
//
// The session identifier is chosen by the client and is not a credential: it only
// has to be stable long enough to group one visit burst into one session.
func ValidateVisit(in VisitInput) (VisitInput, error) {
	in.Path = strings.TrimSpace(in.Path)
	in.Title = strings.TrimSpace(in.Title)
	in.Referrer = strings.TrimSpace(in.Referrer)
	in.Session = strings.TrimSpace(in.Session)

	if in.Path == "" || !strings.HasPrefix(in.Path, "/") {
		return VisitInput{}, fmt.Errorf("%w: path must start with /", ErrInvalidInput)
	}
	if len(in.Path) > MaxPathLength {
		return VisitInput{}, fmt.Errorf("%w: path is too long", ErrInvalidInput)
	}
	if len([]rune(in.Title)) > MaxTitleLength {
		return VisitInput{}, fmt.Errorf("%w: title is too long", ErrInvalidInput)
	}
	if len(in.Referrer) > MaxReferrerLength {
		return VisitInput{}, fmt.Errorf("%w: referrer is too long", ErrInvalidInput)
	}
	if in.Session == "" {
		return VisitInput{}, fmt.Errorf("%w: session is required", ErrInvalidInput)
	}
	if len(in.Session) > MaxSessionLength {
		return VisitInput{}, fmt.Errorf("%w: session is too long", ErrInvalidInput)
	}
	if !in.Surface.Valid() {
		return VisitInput{}, fmt.Errorf("%w: unknown surface", ErrInvalidInput)
	}
	return in, nil
}

// Actor is the caller reading a report.
type Actor struct {
	UserID string
	SiteID string
	Role   site.Role
}

// Totals are the headline numbers of a report.
type Totals struct {
	Views    int
	Sessions int
	Online   int
}

// Point is one bucket of the series. Labels are preformatted for the chart.
type Point struct {
	Label string
	Count int
}

// TopPage is one row of the page leaderboard.
type TopPage struct {
	Path  string
	Count int
}

// TopContent is one row of the content leaderboard.
type TopContent struct {
	ID    string
	Count int
}

// SourceCount is one row of the traffic source breakdown.
//
// Sessions can be counted under more than one source: a reader that arrives from
// search and returns from a direct bookmark is one session in the total but appears
// in both source rows, which is what the breakdown is meant to show.
type SourceCount struct {
	Source   Source
	Visits   int
	Sessions int
}

// DeviceCount is one row of the device breakdown.
type DeviceCount struct {
	Device   Device
	Visits   int
	Sessions int
}

// ReferrerCount is one row of the referrer host leaderboard.
type ReferrerCount struct {
	Host   string
	Visits int
}

// RetentionPoint is one day of the new versus returning session series.
type RetentionPoint struct {
	Date              string
	NewSessions       int
	ReturningSessions int
}

// SessionVisit is one public page view projected to the session that produced it.
//
// The report needs it to count, per day, which sessions were active; the timestamp
// stays UTC and the day is decided by the domain in the reader's zone.
type SessionVisit struct {
	Session string
	At      time.Time
}

// SessionFirstSeen is the earliest public page view of one session.
type SessionFirstSeen struct {
	Session string
	FirstAt time.Time
}

// Report is the complete dashboard payload.
type Report struct {
	Range        Range
	Totals       Totals
	Series       []Point
	TopPages     []TopPage
	TopContent   []TopContent
	Recent       []RecentVisit
	Sources      []SourceCount
	Devices      []DeviceCount
	TopReferrers []ReferrerCount
	Retention    []RetentionPoint
}

// Query narrows a report aggregation.
type Query struct {
	SiteID string
	// Start is inclusive and aligned to the first bucket.
	Start time.Time
	// End is inclusive; the service passes the report clock.
	End time.Time
	// OnlineSince is the start of the "currently online" window.
	OnlineSince time.Time
}

// Aggregate is the raw result of a report query.
//
// The store returns timestamps and page counts rather than preformatted buckets:
// bucketing is a time zone and labelling decision that belongs to the domain, and
// keeping it there makes it testable without a database.
type Aggregate struct {
	Views      int
	Sessions   int
	Online     int
	Timestamps []time.Time
	PageCounts []TopPage
	Recent     []RecentVisit

	SourceCounts   []SourceCount
	DeviceCounts   []DeviceCount
	ReferrerCounts []ReferrerCount
	// SessionVisits and SessionFirstSeen are the raw retention inputs. The store
	// returns rows rather than per day counts because a day is a calendar boundary
	// in the reader's zone; only the domain knows that zone.
	SessionVisits    []SessionVisit
	SessionFirstSeen []SessionFirstSeen
}

// RecentVisit is one of the latest page views shown in the dashboard activity list.
type RecentVisit struct {
	Path      string
	Title     string
	Referrer  string
	Session   string
	CreatedAt time.Time
}

// Repository is the persistence contract for analytics.
type Repository interface {
	// Insert stores one page view.
	Insert(ctx context.Context, visit Visit) error
	// Aggregate computes the counts of one report window.
	Aggregate(ctx context.Context, query Query) (Aggregate, error)
}

// Window is the bucket layout of a range.
type Window struct {
	Start  time.Time
	Step   time.Duration
	Labels []string
}

// End returns the exclusive end of the window.
func (w Window) End() time.Time { return w.Start.Add(time.Duration(len(w.Labels)) * w.Step) }

// Index returns the bucket containing at.
func (w Window) Index(at time.Time) (int, bool) {
	if at.Before(w.Start) || !at.Before(w.End()) {
		return 0, false
	}
	index := int(at.Sub(w.Start) / w.Step)
	if index < 0 || index >= len(w.Labels) {
		return 0, false
	}
	return index, true
}

// Window builds the bucket layout for a range.
//
// The caller supplies the clock and its zone: the stored timestamps remain UTC, while
// the buckets and labels must align with the dashboard reader's local day and hour.
// The handler passes the browser's UTC offset so two replicas produce the same report.
// The 24h layout is 24 hourly buckets ending with the current partial hour; longer
// ranges are whole days ending today. Labels mirror what the dashboard chart renders
// ("15:00" for hours, "10/24" for days).
func (r Range) Window(now time.Time) Window {
	switch r {
	case Range7d, Range30d:
		days := 7
		if r == Range30d {
			days = 30
		}
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).
			AddDate(0, 0, -(days - 1))
		labels := make([]string, days)
		for index := range labels {
			labels[index] = start.AddDate(0, 0, index).Format("1/2")
		}
		return Window{Start: start, Step: 24 * time.Hour, Labels: labels}

	default:
		start := now.Truncate(time.Hour).Add(-23 * time.Hour)
		labels := make([]string, 24)
		for index := range labels {
			labels[index] = start.Add(time.Duration(index) * time.Hour).Format("15:04")
		}
		return Window{Start: start, Step: time.Hour, Labels: labels}
	}
}

// contentPath matches the public detail URLs the web app emits: /a/{id} for an
// article and /p/{id} for a post. The id is bounded to what an id can be, so a
// crafted path cannot inject an arbitrary long leaderboard key.
var contentPath = regexp.MustCompile(`^/[ap]/([A-Za-z0-9_-]{1,64})(?:[/?#]|$)`)

// ContentIDFromPath extracts the content id from a detail path.
//
// Leaderboard attribution is done here rather than at write time because the visit
// endpoint intentionally accepts an opaque path: recording a visit must never turn
// into a content lookup that can fail and drop the write.
func ContentIDFromPath(path string) (string, bool) {
	match := contentPath.FindStringSubmatch(path)
	if match == nil {
		return "", false
	}
	return match[1], true
}
