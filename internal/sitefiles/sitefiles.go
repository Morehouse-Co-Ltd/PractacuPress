// Package sitefiles renders the crawler-facing files of one site: the XML sitemap
// and robots.txt.
//
// The files used to be assembled in the browser by the admin SEO screen. That made
// them a download instead of a URL, and the robots.txt it produced advertised
// /sitemap.xml while the server answered 404. Generation belongs on the server: only
// it knows which site the request Host resolved to and which content is published.
package sitefiles

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/permalink"
	"github.com/practacu/practacu-press/internal/platform/page"
)

// Sitemap protocol limits. A sitemap may contain at most 50,000 URLs; paging stops
// at exactly that bound rather than growing without limit on a huge site.
const (
	pageSize = 100
	maxPages = 500
)

// Item is one published content item that belongs in the sitemap.
//
// Slug and ID are rendered through the site's permalink structure. CanonicalURL
// overrides that path when the author pinned an external canonical address.
type Item struct {
	ID           string
	Slug         string
	Kind         content.Kind
	CanonicalURL string
	PublishedAt  time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Page is one custom page from the site's design document.
type Page struct {
	Slug      string `json:"slug"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updated_at"`
}

// Entry is one <url> element.
type Entry struct {
	Loc          string
	LastModified string
	ChangeFreq   string
	Priority     float64
}

// SEO is the subset of the design document that changes what crawlers may read.
type SEO struct {
	// Indexable defaults to true when the document has no SEO section, matching the
	// frontend default.
	Indexable     bool
	CanonicalBase string
	Permalinks    permalink.Settings
}

// ParseCustomization reads the SEO settings and pages out of a stored design
// document.
//
// The document is opaque to the API by design, so this is a read-only projection:
// an unreadable document yields the defaults instead of an error. A broken design
// must not take the sitemap offline, and the frontend would show the same defaults.
func ParseCustomization(document []byte) (SEO, []Page) {
	seo := SEO{Indexable: true, Permalinks: permalink.Defaults()}
	if len(bytes.TrimSpace(document)) == 0 {
		return seo, nil
	}

	var decoded struct {
		SEO *struct {
			Indexable     *bool               `json:"indexable"`
			CanonicalBase string              `json:"canonical_base"`
			Permalinks    *permalink.Settings `json:"permalinks"`
		} `json:"seo"`
		Pages []Page `json:"pages"`
	}
	if err := json.Unmarshal(document, &decoded); err != nil {
		return seo, nil
	}
	seo.Permalinks = permalink.ParseCustomization(document)

	if decoded.SEO != nil {
		if decoded.SEO.Indexable != nil {
			seo.Indexable = *decoded.SEO.Indexable
		}
		seo.CanonicalBase = strings.TrimRight(strings.TrimSpace(decoded.SEO.CanonicalBase), "/")
	}
	return seo, decoded.Pages
}

// ContentLister lists a site's visible content one page at a time.
//
// It is the read side of content.Service. An unauthenticated actor sees published
// items only, which is exactly the set a sitemap may advertise.
type ContentLister interface {
	ListAfterFilter(
		ctx context.Context,
		actor content.Actor,
		kind content.Kind,
		limit int,
		after page.Cursor,
		narrow content.ListFilter,
	) ([]content.Content, string, error)
}

// Published returns the published items of one site, up to the sitemap URL limit.
//
// The actor deliberately carries no user id and no role, so the service applies the
// anonymous visibility rule. The status check is defence in depth: a future change
// to that rule must not silently put a draft into the sitemap.
func Published(ctx context.Context, lister ContentLister, siteID string) ([]Item, error) {
	if lister == nil || siteID == "" {
		return nil, nil
	}

	actor := content.Actor{SiteID: siteID}
	items := make([]Item, 0, pageSize)
	var after page.Cursor

	for pages := 0; pages < maxPages; pages++ {
		found, next, err := lister.ListAfterFilter(ctx, actor, "", pageSize, after, content.ListFilter{})
		if err != nil {
			return nil, err
		}
		for _, item := range found {
			if item.Status != content.StatusPublished || item.ID == "" {
				continue
			}
			// A trashed item is not a crawlable page any more. The listing already
			// excludes it, and the explicit check keeps a sitemap from advertising a
			// URL that answers 404 - the one thing a sitemap must never do.
			if item.DeletedAt != nil {
				continue
			}
			// A sitemap advertises crawlable URLs. Password and members-only items
			// are direct-link-only, so they must never be listed here.
			if item.AccessMode != "" && item.AccessMode != content.AccessPublic {
				continue
			}
			// An item the author marked noindex may still be readable, but it is
			// explicitly not an invitation to crawl.
			if item.Robots.NoIndex() {
				continue
			}
			items = append(items, Item{
				ID:           item.ID,
				Slug:         item.Slug,
				Kind:         item.Kind,
				CanonicalURL: item.CanonicalURL,
				PublishedAt:  publishedAt(item),
				CreatedAt:    item.CreatedAt,
				UpdatedAt:    item.UpdatedAt,
			})
		}
		if next == "" {
			break
		}
		after, err = page.Decode(next)
		if err != nil {
			return nil, err
		}
	}
	return items, nil
}

// Build renders the sitemap entries for a site.
//
// Content URLs follow the site's article and post structures. Custom pages remain at
// /{slug}; items without a slug fall back to their ID, and author canonical URLs win.
// origin is trimmed of its trailing slash so locs never contain a double slash.
func Build(origin string, items []Item, pages []Page, permalinkSettings ...permalink.Settings) []Entry {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	settings := permalink.Defaults()
	if len(permalinkSettings) > 0 {
		settings = permalinkSettings[0]
	}

	entries := make([]Entry, 0, len(items)+len(pages)+3)
	entries = append(entries,
		Entry{Loc: origin + "/", ChangeFreq: "daily", Priority: 1},
		Entry{Loc: origin + "/articles", ChangeFreq: "daily", Priority: 0.8},
		Entry{Loc: origin + "/posts", ChangeFreq: "daily", Priority: 0.8},
	)

	for _, item := range items {
		loc := itemLoc(origin, item, settings)
		if loc == "" {
			continue
		}
		entries = append(entries, Entry{
			Loc:          loc,
			LastModified: lastModified(item.UpdatedAt),
			ChangeFreq:   "monthly",
			Priority:     0.7,
		})
	}

	for _, custom := range pages {
		if custom.Status != string(content.StatusPublished) {
			continue
		}
		slug := strings.TrimSpace(custom.Slug)
		if slug == "" {
			continue
		}
		entries = append(entries, Entry{
			Loc:          origin + "/" + url.PathEscape(slug),
			LastModified: lastModifiedString(custom.UpdatedAt),
			ChangeFreq:   "monthly",
			Priority:     0.5,
		})
	}
	return entries
}

// itemLoc builds the public address of one content item.
//
// The canonical override is emitted verbatim: it may point at another host (a
// republished article), and rewriting it would defeat the author's decision. Inside the
// site the slug is the permalink; the id is only a fallback so content that predates
// the slug rule stays crawlable.
func itemLoc(origin string, item Item, settings permalink.Settings) string {
	if canonical := strings.TrimSpace(item.CanonicalURL); canonical != "" {
		return canonical
	}
	if item.Kind != content.KindArticle && item.Kind != content.KindPost {
		return ""
	}
	date := item.CreatedAt
	if !item.PublishedAt.IsZero() {
		date = item.PublishedAt
	}
	path := permalink.Path(settings, permalink.Item{
		Kind: string(item.Kind), ID: item.ID, Slug: item.Slug, Date: date,
	})
	if path == "" {
		return ""
	}
	return origin + path
}

func publishedAt(item content.Content) time.Time {
	if item.PublishedAt != nil {
		return *item.PublishedAt
	}
	return time.Time{}
}

// XML renders the sitemap document.
func XML(entries []Entry) []byte {
	var builder strings.Builder
	builder.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	builder.WriteString("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n")
	for _, entry := range entries {
		builder.WriteString("  <url>\n")
		builder.WriteString("    <loc>")
		builder.WriteString(escapeXML(entry.Loc))
		builder.WriteString("</loc>\n")
		if entry.LastModified != "" {
			builder.WriteString("    <lastmod>")
			builder.WriteString(escapeXML(entry.LastModified))
			builder.WriteString("</lastmod>\n")
		}
		if entry.ChangeFreq != "" {
			builder.WriteString("    <changefreq>")
			builder.WriteString(escapeXML(entry.ChangeFreq))
			builder.WriteString("</changefreq>\n")
		}
		builder.WriteString("    <priority>")
		builder.WriteString(strconv.FormatFloat(entry.Priority, 'f', 1, 64))
		builder.WriteString("</priority>\n")
		builder.WriteString("  </url>\n")
	}
	builder.WriteString("</urlset>\n")
	return []byte(builder.String())
}

// Robots renders robots.txt.
//
// The blocked paths are the dashboard and the authentication screens, the same set
// the admin SEO screen documented. A members-only site or a site with indexing
// switched off disallows everything; that is a decision the site owner made.
func Robots(origin string, indexable bool) []byte {
	if !indexable {
		return []byte("User-agent: *\nDisallow: /\n")
	}

	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	sitemap := origin + "/sitemap.xml"
	if origin == "" {
		sitemap = "/sitemap.xml"
	}

	lines := []string{
		"User-agent: *",
		"Allow: /",
		"",
		"# Admin pages and the API are not indexed.",
		"Disallow: /admin",
		"Disallow: /api",
		"Disallow: /login",
		"Disallow: /register",
		"Disallow: /forgot-password",
		"Disallow: /reset-password",
		"",
		"Sitemap: " + sitemap,
		"",
	}
	return []byte(strings.Join(lines, "\n"))
}

func lastModified(at time.Time) string {
	if at.IsZero() {
		return ""
	}
	return at.UTC().Format("2006-01-02")
}

// lastModifiedString keeps the date part the frontend wrote. Page timestamps are
// stored as strings in the design document, so the value is only shape-checked, not
// parsed; it is XML escaped before it reaches the document.
func lastModifiedString(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) < 10 {
		return raw
	}
	return raw[:10]
}

func escapeXML(value string) string {
	var buffer bytes.Buffer
	if err := xml.EscapeText(&buffer, []byte(value)); err != nil {
		// EscapeText only fails when the writer fails; bytes.Buffer never does.
		return ""
	}
	return buffer.String()
}
