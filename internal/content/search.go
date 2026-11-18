package content

import (
	"time"

	"github.com/practacu/practacu-press/internal/platform/page"
)

// SearchQuery is a caller supplied search request.
//
// It carries only values the caller controls. Site and visibility are filled by
// the service, so a request parameter can narrow a page but never widen what the
// caller may see.
type SearchQuery struct {
	Term       string
	Kind       Kind
	CategoryID string
	Tag        string
	AuthorID   string
	// Since and Until bound the item creation time, inclusive. Zero means
	// unbounded at that end.
	Since time.Time
	Until time.Time
	// After is the opaque page boundary from a previous response.
	After page.Cursor
	// Limit is the requested page size. Zero or out of range falls back to
	// DefaultSearchLimit.
	Limit int
	// Highlight asks for a plain text body snippet around the first match. The
	// snippet is never HTML: the client escapes and highlights it.
	Highlight bool
}

// SearchFilter is the normalized query the repository executes.
type SearchFilter struct {
	SiteID     string
	Term       string
	Kind       Kind
	CategoryID string
	Tag        string
	AuthorID   string
	Since      time.Time
	Until      time.Time
	After      page.Cursor
	Limit      int
}

// SearchPage is one ordered page of repository results.
type SearchPage struct {
	Items []Content
	// Total is the number of rows matching the filters, across every page.
	Total int
	// NextCursor is empty when this page is the last one.
	NextCursor string
	// Degraded reports that the full text index was unavailable and the
	// repository answered with the portable LIKE fallback.
	Degraded bool
}

// SearchHit is one result together with its optional plain text snippet.
type SearchHit struct {
	Content Content
	Snippet string
}

// SearchResult is the public search projection.
type SearchResult struct {
	Hits       []SearchHit
	Total      int
	NextCursor string
	Degraded   bool
}
