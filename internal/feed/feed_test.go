package feed

import (
	"context"
	"encoding/xml"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/permalink"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/taxonomy"
)

type stubContent struct {
	items  []content.Content
	err    error
	filter content.ListFilter
	actor  content.Actor
	limit  int
}

func (s *stubContent) ListAfterFilter(
	_ context.Context,
	actor content.Actor,
	_ content.Kind,
	limit int,
	_ page.Cursor,
	narrow content.ListFilter,
) ([]content.Content, string, error) {
	s.actor = actor
	s.limit = limit
	s.filter = narrow
	if s.err != nil {
		return nil, "", s.err
	}
	return s.items, "", nil
}

type stubTaxonomy struct {
	terms []taxonomy.Term
	err   error
}

func (s *stubTaxonomy) List(_ context.Context, _ string) ([]taxonomy.Term, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.terms, nil
}

type stubAuthors map[string]string

func (s stubAuthors) PublicMember(_ context.Context, _ string, userID string) (site.Member, error) {
	name, ok := s[userID]
	if !ok {
		return site.Member{}, errors.New("not found")
	}
	return site.Member{UserID: userID, DisplayName: name}, nil
}

func TestParseCustomizationDefaults(t *testing.T) {
	settings, seo := ParseCustomization(nil)

	require.True(t, settings.Enabled)
	require.False(t, settings.FullText)
	require.Equal(t, DefaultLimit, settings.Limit)
	require.True(t, settings.IncludeTaxonomy)
	require.Equal(t, "zh-CN", settings.Language)
	require.True(t, seo.Indexable)
	require.Empty(t, seo.CanonicalBase)
}

func TestParseCustomizationReadsFeedAndSEO(t *testing.T) {
	settings, seo := ParseCustomization([]byte(`{
		"language": "en",
		"feed": {"enabled": false, "full_text": true, "limit": 500, "include_taxonomy": false},
		"seo": {"indexable": false, "canonical_base": "https://press.example.com/"}
	}`))

	require.False(t, settings.Enabled)
	require.True(t, settings.FullText)
	require.Equal(t, MaxLimit, settings.Limit)
	require.False(t, settings.IncludeTaxonomy)
	require.Equal(t, "en", settings.Language)
	require.False(t, seo.Indexable)
	require.Equal(t, "https://press.example.com", seo.CanonicalBase)
}

func TestParseCustomizationKeepsDefaultsOnBrokenDocument(t *testing.T) {
	settings, seo := ParseCustomization([]byte(`{not json`))

	require.True(t, settings.Enabled)
	require.Equal(t, DefaultLimit, settings.Limit)
	require.True(t, seo.Indexable)
}

func TestRSSRendersEscapedPublishedEntries(t *testing.T) {
	published := time.Date(2026, 11, 6, 9, 30, 0, 0, time.UTC)
	channel := Channel{
		Title:       "Press & Notes",
		Description: "A <small> site",
		SiteURL:     "https://press.example.com",
		FeedURL:     "https://press.example.com/rss.xml",
		Language:    "en",
		Updated:     published,
		Items: []Item{{
			ID:           "a1",
			Kind:         content.KindArticle,
			Title:        `Hello & "world"`,
			URL:          "https://press.example.com/a/a1",
			Summary:      `A <b>summary</b>`,
			HTML:         `<p>Body & more</p>`,
			AuthorName:   "A & B",
			CategoryName: "News",
			Tags:         []string{"Go", "R&D"},
			PublishedAt:  published,
			UpdatedAt:    published,
		}},
	}

	body := RSS(channel)
	require.Contains(t, string(body), `<content:encoded>&lt;p&gt;Body &amp; more&lt;/p&gt;</content:encoded>`)

	var decoded struct {
		XMLName xml.Name `xml:"rss"`
		Channel struct {
			Title string `xml:"title"`
			Items []struct {
				Title       string   `xml:"title"`
				Link        string   `xml:"link"`
				Description string   `xml:"description"`
				Creator     string   `xml:"creator"`
				Categories  []string `xml:"category"`
				Encoded     string   `xml:"encoded"`
			} `xml:"item"`
		} `xml:"channel"`
	}
	require.NoError(t, xml.Unmarshal(body, &decoded))
	require.Equal(t, "Press & Notes", decoded.Channel.Title)
	require.Len(t, decoded.Channel.Items, 1)
	entry := decoded.Channel.Items[0]
	require.Equal(t, `Hello & "world"`, entry.Title)
	require.Equal(t, "A <b>summary</b>", entry.Description)
	require.Equal(t, "A & B", entry.Creator)
	require.Equal(t, []string{"News", "Go", "R&D"}, entry.Categories)
	require.Equal(t, `<p>Body & more</p>`, entry.Encoded)
	require.Equal(t, "https://press.example.com/a/a1", entry.Link)
	require.Contains(t, string(body), `href="https://press.example.com/rss.xml"`)
}

func TestAtomRendersContentAuthorAndCategories(t *testing.T) {
	published := time.Date(2026, 11, 6, 9, 30, 0, 0, time.UTC)
	channel := Channel{
		Title:       "Press",
		Description: "Notes",
		SiteURL:     "https://press.example.com",
		FeedURL:     "https://press.example.com/atom.xml",
		Language:    "en",
		Updated:     published,
		Items: []Item{{
			ID:           "p1",
			Kind:         content.KindPost,
			Title:        "Post",
			URL:          "https://press.example.com/p/p1",
			Summary:      "Short",
			HTML:         "<p>Full</p>",
			AuthorName:   "Ada",
			CategoryName: "Notes",
			Tags:         []string{"Life"},
			PublishedAt:  published,
			UpdatedAt:    published,
		}},
	}

	body := Atom(channel)

	var decoded struct {
		XMLName xml.Name `xml:"feed"`
		Title   string   `xml:"title"`
		Entries []struct {
			ID     string `xml:"id"`
			Title  string `xml:"title"`
			Author struct {
				Name string `xml:"name"`
			} `xml:"author"`
			Categories []struct {
				Term string `xml:"term,attr"`
			} `xml:"category"`
			Summary string `xml:"summary"`
			Content struct {
				Type string `xml:"type,attr"`
				Body string `xml:",chardata"`
			} `xml:"content"`
		} `xml:"entry"`
	}
	require.NoError(t, xml.Unmarshal(body, &decoded))
	require.Equal(t, "Press", decoded.Title)
	require.Len(t, decoded.Entries, 1)
	entry := decoded.Entries[0]
	require.Equal(t, "https://press.example.com/p/p1", entry.ID)
	require.Equal(t, "Ada", entry.Author.Name)
	require.Equal(t, "Notes", entry.Categories[0].Term)
	require.Equal(t, "Life", entry.Categories[1].Term)
	require.Equal(t, "Short", entry.Summary)
	require.Equal(t, "html", entry.Content.Type)
	require.Equal(t, "<p>Full</p>", entry.Content.Body)
}

func TestBodySelectsTheFormat(t *testing.T) {
	channel := Channel{Title: "Press", FeedURL: "https://press.example.com/x"}
	require.Contains(t, string(Body(channel, FormatRSS)), "<rss")
	require.Contains(t, string(Body(channel, FormatAtom)), "<feed")
	require.Contains(t, ContentType(FormatRSS), "application/rss+xml")
	require.Contains(t, ContentType(FormatAtom), "application/atom+xml")
}

func TestBuildProjectionAndVisibility(t *testing.T) {
	published := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	lister := &stubContent{items: []content.Content{
		{
			ID: "a1", SiteID: "site_1", AuthorID: "u1", Kind: content.KindArticle,
			Status: content.StatusPublished, Title: "Hello", Slug: "hello", Summary: "Short",
			RenderedHTML: "<p>Body</p>", CategoryID: "cat_1", Tags: []string{"Go"},
			PublishedAt: &published, CreatedAt: published, UpdatedAt: published,
		},
		{
			ID: "draft", SiteID: "site_1", Kind: content.KindArticle,
			Status: content.StatusDraft, Title: "Draft", CreatedAt: published,
		},
	}}
	taxonomies := &stubTaxonomy{terms: []taxonomy.Term{
		{ID: "cat_1", Kind: taxonomy.KindCategory, Name: "News", Slug: "news"},
		{ID: "tag_1", Kind: taxonomy.KindTag, Name: "Go", Slug: "go"},
	}}

	channel, err := Build(context.Background(), Source{
		Content: lister, Taxonomy: taxonomies, Authors: stubAuthors{"u1": "Ada"},
	}, Request{
		SiteID: "site_1", SiteName: "Press", SiteDescription: "Notes",
		Origin: "https://press.example.com", FeedURL: "https://press.example.com/rss.xml",
		Settings: Defaults(),
	})
	require.NoError(t, err)

	require.Equal(t, "site_1", lister.actor.SiteID)
	require.Equal(t, DefaultLimit, lister.limit)
	require.Len(t, channel.Items, 1)
	entry := channel.Items[0]
	require.Equal(t, "https://press.example.com/a/hello", entry.URL)
	require.Equal(t, "Ada", entry.AuthorName)
	require.Equal(t, "News", entry.CategoryName)
	require.Equal(t, []string{"Go"}, entry.Tags)
	require.Equal(t, published, entry.PublishedAt)
}

func TestBuildUsesSlugCanonicalAndIDFallbacks(t *testing.T) {
	published := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	lister := &stubContent{items: []content.Content{
		{
			ID: "a1", SiteID: "site_1", Kind: content.KindArticle,
			Status: content.StatusPublished, Title: "Slugged", Slug: "hello-world",
			CreatedAt: published, UpdatedAt: published,
		},
		{
			ID: "p1", SiteID: "site_1", Kind: content.KindPost,
			Status: content.StatusPublished, Title: "Canonical",
			CanonicalURL: "https://elsewhere.example/republished",
			CreatedAt:    published, UpdatedAt: published,
		},
		{
			ID: "legacy", SiteID: "site_1", Kind: content.KindArticle,
			Status: content.StatusPublished, Title: "No slug",
			CreatedAt: published, UpdatedAt: published,
		},
	}}

	channel, err := Build(context.Background(), Source{Content: lister}, Request{
		SiteID: "site_1", SiteName: "Press", Origin: "https://press.example.com",
		Settings: Defaults(),
	})
	require.NoError(t, err)
	require.Len(t, channel.Items, 3)
	require.Equal(t, "https://press.example.com/a/hello-world", channel.Items[0].URL)
	require.Equal(t, "https://elsewhere.example/republished", channel.Items[1].URL)
	require.Equal(t, "https://press.example.com/a/legacy", channel.Items[2].URL)
}

func TestBuildUsesConfiguredPermalinkStructure(t *testing.T) {
	published := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	lister := &stubContent{items: []content.Content{{
		ID: "a1", SiteID: "site_1", Kind: content.KindArticle,
		Status: content.StatusPublished, Title: "Slugged", Slug: "hello-world",
		PublishedAt: &published, CreatedAt: published, UpdatedAt: published,
	}}}
	settings := Defaults()
	settings.Permalinks.ArticleStructure = permalink.StructureDateName

	channel, err := Build(context.Background(), Source{Content: lister}, Request{
		SiteID: "site_1", SiteName: "Press", Origin: "https://press.example.com",
		Settings: settings,
	})
	require.NoError(t, err)
	require.Equal(t, "https://press.example.com/2026/11/06/hello-world", channel.Items[0].URL)
}

func TestBuildFullTextFallsBackToExcerpt(t *testing.T) {
	published := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	lister := &stubContent{items: []content.Content{{
		ID: "a1", SiteID: "site_1", Kind: content.KindArticle, Status: content.StatusPublished,
		Title: "Hello", RenderedHTML: "<p>Long <b>body</b> text</p>",
		CreatedAt: published, UpdatedAt: published,
	}}}
	settings := Defaults()
	settings.FullText = false

	channel, err := Build(context.Background(), Source{Content: lister}, Request{
		SiteID: "site_1", SiteName: "Press", Origin: "https://press.example.com",
		Settings: settings,
	})
	require.NoError(t, err)
	require.Equal(t, "Long body text", channel.Items[0].Summary)
	require.Empty(t, channel.Items[0].HTML)

	settings.FullText = true
	channel, err = Build(context.Background(), Source{Content: lister}, Request{
		SiteID: "site_1", SiteName: "Press", Origin: "https://press.example.com",
		Settings: settings,
	})
	require.NoError(t, err)
	require.Equal(t, "<p>Long <b>body</b> text</p>", channel.Items[0].HTML)
}

func TestBuildResolvesCategoryScope(t *testing.T) {
	lister := &stubContent{}
	taxonomies := &stubTaxonomy{terms: []taxonomy.Term{
		{ID: "cat_1", Kind: taxonomy.KindCategory, Name: "News", Slug: "news", Description: "Latest"},
	}}

	channel, err := Build(context.Background(), Source{Content: lister, Taxonomy: taxonomies}, Request{
		SiteID: "site_1", SiteName: "Press", Origin: "https://press.example.com",
		Scope: ScopeCategory, Slug: "news", Settings: Defaults(),
	})
	require.NoError(t, err)
	require.Equal(t, "cat_1", lister.filter.CategoryID)
	require.Equal(t, "Press · News", channel.Title)
	require.Equal(t, "Latest", channel.Description)

	_, err = Build(context.Background(), Source{Content: lister, Taxonomy: taxonomies}, Request{
		SiteID: "site_1", SiteName: "Press", Scope: ScopeCategory, Slug: "missing",
		Settings: Defaults(),
	})
	require.ErrorIs(t, err, ErrScopeNotFound)
}

func TestBuildTagFallsBackToFreeFormName(t *testing.T) {
	lister := &stubContent{}
	channel, err := Build(context.Background(), Source{Content: lister}, Request{
		SiteID: "site_1", SiteName: "Press", Origin: "https://press.example.com",
		Scope: ScopeTag, Slug: "RSS", Settings: Defaults(),
	})
	require.NoError(t, err)
	require.Equal(t, "RSS", lister.filter.Tag)
	require.Equal(t, "Press · RSS", channel.Title)
}

func TestNotModifiedHonoursETagAndDate(t *testing.T) {
	updated := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	body := RSS(Channel{Title: "Press", FeedURL: "https://press.example.com/rss.xml", Updated: updated})
	etag := ETag(body)

	headers := http.Header{}
	headers.Set("If-None-Match", etag)
	require.True(t, NotModified(headers, etag, updated))

	headers = http.Header{}
	headers.Set("If-Modified-Since", updated.Format(http.TimeFormat))
	require.True(t, NotModified(headers, etag, updated))

	headers.Set("If-Modified-Since", updated.Add(-time.Hour).Format(http.TimeFormat))
	require.False(t, NotModified(headers, etag, updated))

	require.True(t, ifNoneMatchHit(`"x", "y"`, `"y"`))
	require.False(t, ifNoneMatchHit(`W/"y"`, `"y"`))
}

func TestScopeTitle(t *testing.T) {
	require.Equal(t, "Press · News", scopeTitle("Press", "News"))
	require.Equal(t, "News", scopeTitle("", "News"))
	require.Equal(t, "Press", scopeTitle("Press", ""))
}

func TestPlainTextTruncatesWithoutSplittingRunes(t *testing.T) {
	require.Equal(t, "a b", plainText("<p>a</p>\n<b>b</b>"))
	value := truncateRunes(strings.Repeat("字", 5), 3)
	require.Equal(t, "字字字…", value)
}
