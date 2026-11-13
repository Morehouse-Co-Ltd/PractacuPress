// Package feed renders the syndication feeds of one site: RSS 2.0 and Atom 1.0.
//
// A feed is a crawler-facing file, so the same rules as sitemap.xml and robots.txt
// apply: the request Host selects the site, only content an anonymous visitor may
// read is listed, and the site owner's indexing switch can switch the feed off. The
// package therefore contains rendering and projection only; the HTTP layer resolves
// the site and the content service decides visibility.
package feed

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"html"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	"github.com/practacu/practacu-press/apps/api/internal/taxonomy"
)

// Per-source bounds. The content service caps a listing at 100 items, and a feed
// larger than that is a file a reader downloads rather than a notification, so the
// limit is shared with that cap instead of inventing a second one.
const (
	DefaultLimit = 20
	MaxLimit     = 100
)

// ErrScopeNotFound means the category or tag named in the URL does not exist.
var ErrScopeNotFound = errors.New("feed: scope not found")

// Format is the syndication format of one response.
type Format string

// Supported formats.
const (
	FormatRSS  Format = "rss"
	FormatAtom Format = "atom"
)

// Settings is the feed section of the site design document.
type Settings struct {
	// Enabled switches every feed off; a disabled feed answers 404.
	Enabled bool
	// FullText includes the sanitized article body instead of the summary.
	FullText bool
	// Limit bounds the number of entries per feed.
	Limit int
	// IncludeTaxonomy exposes the per category and per tag feeds.
	IncludeTaxonomy bool
	// Language is the BCP 47 language of the site, for RSS <language>.
	Language string
}

// SEO is the subset of the design document that decides whether crawlers may read
// the feed at all.
type SEO struct {
	Indexable     bool
	CanonicalBase string
}

// Defaults returns the feed settings of a site that never saved a design document.
//
// Enabled defaults to true because the shipped theme already links to /rss.xml; a
// fresh install should not render a dead link. Full text defaults to false because a
// summary feed is the safer default for bandwidth and for accidental leakage of text
// that was published for a narrower audience.
func Defaults() Settings {
	return Settings{
		Enabled:         true,
		FullText:        false,
		Limit:           DefaultLimit,
		IncludeTaxonomy: true,
		Language:        "zh-CN",
	}
}

// ParseCustomization reads the feed settings and crawler switches out of a stored
// design document.
//
// The document is opaque to the API, so an unreadable document yields the defaults
// instead of an error: a broken design must not take the feed offline, and the
// frontend would show the same defaults.
func ParseCustomization(document []byte) (Settings, SEO) {
	settings := Defaults()
	seo := SEO{Indexable: true}

	if len(bytes.TrimSpace(document)) == 0 {
		return settings, seo
	}

	var decoded struct {
		Feed *struct {
			Enabled         *bool `json:"enabled"`
			FullText        *bool `json:"full_text"`
			Limit           *int  `json:"limit"`
			IncludeTaxonomy *bool `json:"include_taxonomy"`
		} `json:"feed"`
		Language string `json:"language"`
		SEO      *struct {
			Indexable     *bool  `json:"indexable"`
			CanonicalBase string `json:"canonical_base"`
		} `json:"seo"`
	}
	if err := json.Unmarshal(document, &decoded); err != nil {
		return settings, seo
	}

	if decoded.Feed != nil {
		if decoded.Feed.Enabled != nil {
			settings.Enabled = *decoded.Feed.Enabled
		}
		if decoded.Feed.FullText != nil {
			settings.FullText = *decoded.Feed.FullText
		}
		if decoded.Feed.IncludeTaxonomy != nil {
			settings.IncludeTaxonomy = *decoded.Feed.IncludeTaxonomy
		}
		if decoded.Feed.Limit != nil {
			settings.Limit = clampLimit(*decoded.Feed.Limit)
		}
	}
	settings.Language = normalizeLanguage(decoded.Language)

	if decoded.SEO != nil {
		if decoded.SEO.Indexable != nil {
			seo.Indexable = *decoded.SEO.Indexable
		}
		seo.CanonicalBase = strings.TrimRight(strings.TrimSpace(decoded.SEO.CanonicalBase), "/")
	}
	return settings, seo
}

// clampLimit keeps a stored limit inside the range the content service serves.
func clampLimit(limit int) int {
	if limit <= 0 {
		return DefaultLimit
	}
	if limit > MaxLimit {
		return MaxLimit
	}
	return limit
}

// normalizeLanguage accepts the locales the frontend can store and falls back to the
// same default the rest of the design uses for an unknown value.
func normalizeLanguage(value string) string {
	switch strings.TrimSpace(value) {
	case "en":
		return "en"
	default:
		return "zh-CN"
	}
}

// Scope selects what a feed lists.
type Scope string

// The supported feed scopes.
const (
	ScopeSite     Scope = ""
	ScopeCategory Scope = "category"
	ScopeTag      Scope = "tag"
)

// ContentLister lists a site's visible content one page at a time.
//
// It is the read side of content.Service: the anonymous actor used by Build only
// returns published items, and Build checks the status again as defence in depth.
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

// TaxonomyLister returns the categories and tags of a site. It is used to resolve a
// slug and to label an item's category.
type TaxonomyLister interface {
	List(ctx context.Context, siteID string) ([]taxonomy.Term, error)
}

// AuthorLookup resolves the public display name of an author. A failure is not fatal:
// the entry is still useful without a name, so Build degrades instead of failing.
type AuthorLookup interface {
	PublicMember(ctx context.Context, siteID, userID string) (site.Member, error)
}

// Source is the read side Build uses.
type Source struct {
	Content  ContentLister
	Taxonomy TaxonomyLister
	Authors  AuthorLookup
}

// Request describes the feed to build.
type Request struct {
	SiteID          string
	SiteName        string
	SiteDescription string
	// Origin is the absolute site origin, canonical base first.
	Origin string
	// FeedURL is the absolute URL of this feed.
	FeedURL string
	// FallbackUpdated is used as the channel timestamp when the feed is empty.
	FallbackUpdated time.Time
	// Scope and Slug select a category or tag feed; the zero scope is the site feed.
	Scope    Scope
	Slug     string
	Settings Settings
}

// Item is one feed entry after project onto the feed vocabulary.
type Item struct {
	ID           string
	Kind         content.Kind
	Title        string
	URL          string
	Summary      string
	HTML         string
	AuthorName   string
	CategoryName string
	Tags         []string
	PublishedAt  time.Time
	UpdatedAt    time.Time
}

// Channel is a rendered feed, independent of the syndication format.
type Channel struct {
	Title       string
	Description string
	SiteURL     string
	FeedURL     string
	Language    string
	Updated     time.Time
	Items       []Item
}

// Build projects published content into a feed channel.
//
// Taxonomy is loaded once for the whole feed so labelling each entry does not cost a
// query per item. A category feed whose slug is unknown is ErrScopeNotFound; a tag
// feed falls back to the raw slug because the product lets authors use free-form tags
// that never made it into the taxonomy table.
func Build(ctx context.Context, source Source, request Request) (Channel, error) {
	settings := request.Settings
	settings.Limit = clampLimit(settings.Limit)
	if settings.Language == "" {
		settings.Language = "zh-CN"
	}

	channel := Channel{
		Title:       fallback(request.SiteName, "Practacu Press"),
		Description: fallback(request.SiteDescription, request.SiteName),
		SiteURL:     strings.TrimRight(request.Origin, "/"),
		FeedURL:     request.FeedURL,
		Language:    settings.Language,
		Updated:     request.FallbackUpdated,
	}
	if channel.Description == "" {
		channel.Description = channel.Title
	}

	var terms []taxonomy.Term
	if source.Taxonomy != nil && request.SiteID != "" {
		found, err := source.Taxonomy.List(ctx, request.SiteID)
		if err != nil {
			return Channel{}, err
		}
		terms = found
	}

	categoryByID := make(map[string]taxonomy.Term, len(terms))
	categoryBySlug := make(map[string]taxonomy.Term, len(terms))
	tagBySlug := make(map[string]taxonomy.Term, len(terms))
	for _, term := range terms {
		switch term.Kind {
		case taxonomy.KindCategory:
			categoryByID[term.ID] = term
			categoryBySlug[term.Slug] = term
		case taxonomy.KindTag:
			tagBySlug[term.Slug] = term
		}
	}

	slug := strings.TrimSpace(request.Slug)
	if len([]rune(slug)) > taxonomy.MaxSlugLength {
		return Channel{}, ErrScopeNotFound
	}

	var filter content.ListFilter
	switch request.Scope {
	case ScopeCategory:
		term, ok := categoryBySlug[slug]
		if slug == "" || !ok {
			return Channel{}, ErrScopeNotFound
		}
		filter.CategoryID = term.ID
		channel.Title = scopeTitle(request.SiteName, term.Name)
		if strings.TrimSpace(term.Description) != "" {
			channel.Description = term.Description
		}
	case ScopeTag:
		if slug == "" {
			return Channel{}, ErrScopeNotFound
		}
		name := slug
		if term, ok := tagBySlug[slug]; ok {
			name = term.Name
		}
		filter.Tag = name
		channel.Title = scopeTitle(request.SiteName, name)
	case ScopeSite:
		// No filter: the whole site.
	default:
		return Channel{}, ErrScopeNotFound
	}

	if source.Content == nil || request.SiteID == "" {
		return channel, nil
	}

	// The anonymous actor is what makes the content service return published items
	// only. The status is checked again below so a future visibility change cannot
	// silently put a draft into a feed.
	items, _, err := source.Content.ListAfterFilter(
		ctx,
		content.Actor{SiteID: request.SiteID},
		"",
		settings.Limit,
		page.Cursor{},
		filter,
	)
	if err != nil {
		return Channel{}, err
	}

	authorNames := make(map[string]string)
	for _, item := range items {
		if item.Status != content.StatusPublished || item.ID == "" {
			continue
		}
		// Password and members-only items are direct-link-only; a feed must never
		// disclose them even if a future visibility change widened the listing.
		if item.AccessMode != "" && item.AccessMode != content.AccessPublic {
			continue
		}
		link := itemURL(channel.SiteURL, item)
		if link == "" {
			continue
		}

		authorName := ""
		if item.AuthorID != "" {
			if cached, ok := authorNames[item.AuthorID]; ok {
				authorName = cached
			} else {
				authorName = lookupAuthor(ctx, source.Authors, request.SiteID, item.AuthorID)
				authorNames[item.AuthorID] = authorName
			}
		}

		categoryName := ""
		if term, ok := categoryByID[item.CategoryID]; ok {
			categoryName = term.Name
		}

		published := item.CreatedAt
		if item.PublishedAt != nil && !item.PublishedAt.IsZero() {
			published = *item.PublishedAt
		}
		updated := item.UpdatedAt
		if updated.IsZero() {
			updated = published
		}
		if updated.After(channel.Updated) {
			channel.Updated = updated
		}

		channel.Items = append(channel.Items, Item{
			ID:           item.ID,
			Kind:         item.Kind,
			Title:        item.Title,
			URL:          link,
			Summary:      summary(item),
			HTML:         fullText(item, settings.FullText),
			AuthorName:   authorName,
			CategoryName: categoryName,
			Tags:         nonNil(item.Tags),
			PublishedAt:  published,
			UpdatedAt:    updated,
		})
	}

	return channel, nil
}

// lookupAuthor resolves a display name, degrading to an empty value.
func lookupAuthor(ctx context.Context, lookup AuthorLookup, siteID, userID string) string {
	if lookup == nil {
		return ""
	}
	member, err := lookup.PublicMember(ctx, siteID, userID)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(member.DisplayName)
}

// itemURL builds the public address of one content item. The route shape mirrors
// the frontend: /a/{id} for articles and /p/{id} for posts.
func itemURL(origin string, item content.Content) string {
	prefix := ""
	switch item.Kind {
	case content.KindArticle:
		prefix = "/a/"
	case content.KindPost:
		prefix = "/p/"
	default:
		return ""
	}
	return strings.TrimRight(origin, "/") + prefix + item.ID
}

// fullText returns the sanitized body when the owner enabled full text, otherwise
// the empty string (the summary is rendered separately).
func fullText(item content.Content, enabled bool) string {
	if !enabled {
		return ""
	}
	return strings.TrimSpace(item.RenderedHTML)
}

// summary returns the author's summary, falling back to a plain-text excerpt of the
// rendered body so an entry never reaches a reader with no description at all.
func summary(item content.Content) string {
	if value := strings.TrimSpace(item.Summary); value != "" {
		return value
	}
	return truncateRunes(plainText(item.RenderedHTML), 280)
}

var (
	xmlTagPattern   = regexp.MustCompile(`(?s)<[^>]*>`)
	spaceRunPattern = regexp.MustCompile(`\s+`)
)

// plainText strips markup for a summary. It is not a sanitizer: the result only ever
// reaches an XML text node, where escaping is the authority on safety.
func plainText(markup string) string {
	text := xmlTagPattern.ReplaceAllString(markup, " ")
	text = html.UnescapeString(text)
	return strings.TrimSpace(spaceRunPattern.ReplaceAllString(text, " "))
}

// truncateRunes bounds a summary without cutting a multi-byte character in half.
func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

// scopeTitle combines the site name with the category or tag name.
func scopeTitle(siteName, scopeName string) string {
	siteName = strings.TrimSpace(siteName)
	scopeName = strings.TrimSpace(scopeName)
	switch {
	case siteName == "":
		return scopeName
	case scopeName == "":
		return siteName
	default:
		return siteName + " · " + scopeName
	}
}

func fallback(value, other string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return strings.TrimSpace(other)
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// LastModified returns the channel timestamp truncated to the HTTP header precision.
func (c Channel) LastModified() time.Time {
	if c.Updated.IsZero() {
		return time.Time{}
	}
	return c.Updated.UTC().Truncate(time.Second)
}

// ETag derives a strong validator from the rendered bytes.
func ETag(body []byte) string {
	sum := sha256.Sum256(body)
	return `"` + hex.EncodeToString(sum[:16]) + `"`
}

// NotModified reports whether the request's conditional headers match this feed.
//
// If-None-Match wins when both are present, matching the HTTP rule that an entity tag
// is a stronger validator than a date.
func NotModified(header http.Header, etag string, updated time.Time) bool {
	if ifNoneMatchHit(header.Get("If-None-Match"), etag) {
		return true
	}
	raw := strings.TrimSpace(header.Get("If-Modified-Since"))
	if raw == "" || updated.IsZero() {
		return false
	}
	since, err := http.ParseTime(raw)
	if err != nil {
		return false
	}
	return !updated.UTC().Truncate(time.Second).After(since.UTC())
}

func ifNoneMatchHit(value, etag string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	if value == "*" {
		return true
	}
	for _, candidate := range strings.Split(value, ",") {
		if strings.TrimSpace(candidate) == etag {
			return true
		}
	}
	return false
}

// ContentType returns the media type of a feed format.
func ContentType(format Format) string {
	if format == FormatAtom {
		return "application/atom+xml; charset=utf-8"
	}
	return "application/rss+xml; charset=utf-8"
}

// RSS renders the channel as RSS 2.0.
func RSS(channel Channel) []byte {
	var builder strings.Builder
	builder.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	builder.WriteString("<rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:content=\"http://purl.org/rss/1.0/modules/content/\">\n")
	builder.WriteString("  <channel>\n")
	writeElementIndent(&builder, "title", channel.Title, "    ")
	writeElementIndent(&builder, "link", channel.SiteURL, "    ")
	writeElementIndent(&builder, "description", channel.Description, "    ")
	writeElementIndent(&builder, "language", channel.Language, "    ")
	if !channel.Updated.IsZero() {
		writeElementIndent(&builder, "lastBuildDate", rssTime(channel.Updated), "    ")
	}
	writeElementIndent(&builder, "generator", "Practacu Press", "    ")
	builder.WriteString("    <atom:link href=\"")
	builder.WriteString(escape(channel.FeedURL))
	builder.WriteString("\" rel=\"self\" type=\"application/rss+xml\"/>\n")

	for _, item := range channel.Items {
		builder.WriteString("    <item>\n")
		writeElementIndent(&builder, "title", item.Title, "      ")
		writeElementIndent(&builder, "link", item.URL, "      ")
		builder.WriteString("      <guid isPermaLink=\"false\">")
		builder.WriteString(escape(string(item.Kind) + ":" + item.ID))
		builder.WriteString("</guid>\n")
		if !item.PublishedAt.IsZero() {
			writeElementIndent(&builder, "pubDate", rssTime(item.PublishedAt), "      ")
		}
		writeElementIndent(&builder, "description", item.Summary, "      ")
		if item.AuthorName != "" {
			writeElementIndent(&builder, "dc:creator", item.AuthorName, "      ")
		}
		if item.CategoryName != "" {
			writeElementIndent(&builder, "category", item.CategoryName, "      ")
		}
		for _, tag := range item.Tags {
			writeElementIndent(&builder, "category", tag, "      ")
		}
		if item.HTML != "" {
			writeElementIndent(&builder, "content:encoded", item.HTML, "      ")
		}
		builder.WriteString("    </item>\n")
	}

	builder.WriteString("  </channel>\n</rss>\n")
	return []byte(builder.String())
}

// Atom renders the channel as Atom 1.0.
func Atom(channel Channel) []byte {
	var builder strings.Builder
	builder.WriteString("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n")
	builder.WriteString("<feed xmlns=\"http://www.w3.org/2005/Atom\">\n")
	writeElementIndent(&builder, "id", channel.FeedURL, "  ")
	writeElementIndent(&builder, "title", channel.Title, "  ")
	writeElementIndent(&builder, "subtitle", channel.Description, "  ")
	writeElementIndent(&builder, "updated", rfc3339(channel.Updated), "  ")
	builder.WriteString("  <link rel=\"alternate\" type=\"text/html\" href=\"")
	builder.WriteString(escape(channel.SiteURL))
	builder.WriteString("\"/>\n")
	builder.WriteString("  <link rel=\"self\" type=\"application/atom+xml\" href=\"")
	builder.WriteString(escape(channel.FeedURL))
	builder.WriteString("\"/>\n")
	builder.WriteString("  <generator>Practacu Press</generator>\n")

	for _, item := range channel.Items {
		builder.WriteString("  <entry>\n")
		writeElementIndent(&builder, "id", item.URL, "    ")
		writeElementIndent(&builder, "title", item.Title, "    ")
		if !item.PublishedAt.IsZero() {
			writeElementIndent(&builder, "published", rfc3339(item.PublishedAt), "    ")
		}
		updated := item.UpdatedAt
		if updated.IsZero() {
			updated = item.PublishedAt
		}
		writeElementIndent(&builder, "updated", rfc3339(updated), "    ")
		builder.WriteString("    <link rel=\"alternate\" type=\"text/html\" href=\"")
		builder.WriteString(escape(item.URL))
		builder.WriteString("\"/>\n")
		if item.AuthorName != "" {
			builder.WriteString("    <author>\n")
			writeElementIndent(&builder, "name", item.AuthorName, "      ")
			builder.WriteString("    </author>\n")
		}
		if item.CategoryName != "" {
			builder.WriteString("    <category term=\"")
			builder.WriteString(escape(item.CategoryName))
			builder.WriteString("\" label=\"")
			builder.WriteString(escape(item.CategoryName))
			builder.WriteString("\"/>\n")
		}
		for _, tag := range item.Tags {
			builder.WriteString("    <category term=\"")
			builder.WriteString(escape(tag))
			builder.WriteString("\" label=\"")
			builder.WriteString(escape(tag))
			builder.WriteString("\"/>\n")
		}
		writeElementIndent(&builder, "summary", item.Summary, "    ")
		if item.HTML != "" {
			builder.WriteString("    <content type=\"html\">")
			builder.WriteString(escape(item.HTML))
			builder.WriteString("</content>\n")
		}
		builder.WriteString("  </entry>\n")
	}

	builder.WriteString("</feed>\n")
	return []byte(builder.String())
}

func writeElementIndent(builder *strings.Builder, name, value, indent string) {
	builder.WriteString(indent)
	builder.WriteString("<")
	builder.WriteString(name)
	builder.WriteString(">")
	builder.WriteString(escape(value))
	builder.WriteString("</")
	builder.WriteString(name)
	builder.WriteString(">\n")
}

func escape(value string) string {
	var buffer bytes.Buffer
	if err := xml.EscapeText(&buffer, []byte(value)); err != nil {
		// EscapeText only fails when the writer fails; bytes.Buffer never does.
		return ""
	}
	return buffer.String()
}

// rssTime renders an RSS date. The literal layout is the RFC 1123 form RSS expects.
func rssTime(value time.Time) string {
	return value.UTC().Format("Mon, 02 Jan 2006 15:04:05 -0700")
}

// rfc3339 renders an Atom timestamp.
func rfc3339(value time.Time) string {
	if value.IsZero() {
		value = time.Unix(0, 0).UTC()
	}
	return value.UTC().Format(time.RFC3339)
}

// Body renders a channel in the requested format.
func Body(channel Channel, format Format) []byte {
	if format == FormatAtom {
		return Atom(channel)
	}
	return RSS(channel)
}
