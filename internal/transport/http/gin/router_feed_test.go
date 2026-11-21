package ginrouter

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/taxonomy"
)

type feedContentLister struct {
	items  []content.Content
	err    error
	filter content.ListFilter
	limit  int
	actor  content.Actor
}

func (s *feedContentLister) ListAfterFilter(
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

type feedTaxonomyLister struct {
	terms []taxonomy.Term
	err   error
}

func (s *feedTaxonomyLister) List(_ context.Context, _ string) ([]taxonomy.Term, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.terms, nil
}

type feedAuthors map[string]string

func (a feedAuthors) PublicMember(_ context.Context, _ string, userID string) (site.Member, error) {
	name, ok := a[userID]
	if !ok {
		return site.Member{}, site.ErrTargetNotFound
	}
	return site.Member{UserID: userID, DisplayName: name}, nil
}

func feedRouter(
	t *testing.T,
	resolved site.Site,
	customization *stubCustomization,
	lister *feedContentLister,
	taxonomies *feedTaxonomyLister,
	authors feedAuthors,
) *httptest.Server {
	t.Helper()

	r := testRouter(t, Dependencies{
		Config:       config.Config{AppEnv: config.EnvTest},
		SiteResolver: &stubSiteResolver{site: resolved},
		Feed: FeedDependencies{
			Customization: customization,
			Content:       lister,
			Taxonomy:      taxonomies,
			Authors:       authors,
		},
	})
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)
	return server
}

func publishedFeedFixture() (site.Site, *feedContentLister, *feedTaxonomyLister, feedAuthors, time.Time) {
	at := time.Date(2026, 11, 6, 9, 30, 0, 0, time.UTC)
	resolved := site.Site{ID: "site_1", Name: "Press", Description: "Notes", CreatedAt: at}
	lister := &feedContentLister{items: []content.Content{
		{
			ID: "a1", SiteID: "site_1", AuthorID: "u1", Kind: content.KindArticle,
			Status: content.StatusPublished, Title: "Hello & welcome", Summary: "Short <b>summary</b>",
			RenderedHTML: "<p>Body</p>", CategoryID: "cat_1", Tags: []string{"Go"},
			PublishedAt: &at, CreatedAt: at, UpdatedAt: at,
		},
		{
			ID: "draft", SiteID: "site_1", Kind: content.KindArticle,
			Status: content.StatusDraft, Title: "Draft", CreatedAt: at, UpdatedAt: at,
		},
	}}
	taxonomies := &feedTaxonomyLister{terms: []taxonomy.Term{
		{ID: "cat_1", Kind: taxonomy.KindCategory, Name: "News", Slug: "news", Description: "Latest"},
		{ID: "tag_1", Kind: taxonomy.KindTag, Name: "Go", Slug: "go"},
	}}
	return resolved, lister, taxonomies, feedAuthors{"u1": "Ada"}, at
}

func TestFeedServesRSSForTheResolvedHost(t *testing.T) {
	resolved, lister, taxonomies, authors, at := publishedFeedFixture()
	server := feedRouter(t, resolved, &stubCustomization{}, lister, taxonomies, authors)

	res, body := get(t, server, "/rss.xml")

	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, res.Header.Get("Content-Type"), "application/rss+xml")
	require.Contains(t, res.Header.Get("Cache-Control"), "max-age=300")
	require.NotEmpty(t, res.Header.Get("ETag"))
	require.NotEmpty(t, res.Header.Get("Last-Modified"))
	require.Contains(t, body, "<title>Press</title>")
	require.Contains(t, body, "http://press.example.com/a1")
	require.Contains(t, body, "Hello &amp; welcome")
	require.Contains(t, body, "Ada")
	require.Contains(t, body, "News")
	require.NotContains(t, body, "http://press.example.com/draft")
	require.Equal(t, "site_1", lister.actor.SiteID)
	require.Equal(t, 20, lister.limit)

	conditional, err := http.NewRequest(http.MethodGet, server.URL+"/rss.xml", nil)
	require.NoError(t, err)
	conditional.Host = "press.example.com"
	conditional.Header.Set("If-None-Match", res.Header.Get("ETag"))
	notModified, err := server.Client().Do(conditional)
	require.NoError(t, err)
	t.Cleanup(func() { _ = notModified.Body.Close() })
	require.Equal(t, http.StatusNotModified, notModified.StatusCode)
	require.Equal(t, at.Format(http.TimeFormat), res.Header.Get("Last-Modified"))
}

func TestFeedServesAtomAndTheFeedAlias(t *testing.T) {
	resolved, lister, taxonomies, authors, _ := publishedFeedFixture()
	server := feedRouter(t, resolved, &stubCustomization{document: []byte(`{"feed": {"full_text": true}}`)}, lister, taxonomies, authors)

	res, body := get(t, server, "/atom.xml")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, res.Header.Get("Content-Type"), "application/atom+xml")
	require.Contains(t, body, `<feed xmlns="http://www.w3.org/2005/Atom">`)
	require.Contains(t, body, "<content type=\"html\">")

	res, body = get(t, server, "/feed.xml")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, res.Header.Get("Content-Type"), "application/rss+xml")
	require.Contains(t, body, "<rss version=\"2.0\"")
}

func TestFeedUsesTheConfiguredCanonicalBase(t *testing.T) {
	resolved, lister, taxonomies, authors, _ := publishedFeedFixture()
	server := feedRouter(t, resolved, &stubCustomization{document: []byte(`{
		"seo": {"canonical_base": "https://press.example.com/"}
	}`)}, lister, taxonomies, authors)

	_, body := get(t, server, "/rss.xml")
	require.Contains(t, body, "https://press.example.com/a1")
	require.Contains(t, body, `href="https://press.example.com/rss.xml"`)
}

func TestFeedHonoursTheOwnerSwitches(t *testing.T) {
	resolved, lister, taxonomies, authors, _ := publishedFeedFixture()

	cases := map[string]*stubCustomization{
		"feed disabled":      {document: []byte(`{"feed": {"enabled": false}}`)},
		"indexing disabled":  {document: []byte(`{"seo": {"indexable": false}}`)},
		"taxonomy feeds off": {document: []byte(`{"feed": {"include_taxonomy": false}}`)},
	}
	for name, customization := range cases {
		t.Run(name, func(t *testing.T) {
			server := feedRouter(t, resolved, customization, lister, taxonomies, authors)
			path := "/rss.xml"
			if name == "taxonomy feeds off" {
				path = "/category/news/rss.xml"
			}
			res, _ := get(t, server, path)
			require.Equal(t, http.StatusNotFound, res.StatusCode)
		})
	}

	t.Run("members only", func(t *testing.T) {
		members := resolved
		members.VisibilityMode = site.VisibilityMembersOnly
		server := feedRouter(t, members, &stubCustomization{}, lister, taxonomies, authors)
		res, _ := get(t, server, "/rss.xml")
		require.Equal(t, http.StatusNotFound, res.StatusCode)
	})
}

func TestCategoryAndTagFeedsNarrowTheListing(t *testing.T) {
	resolved, lister, taxonomies, authors, _ := publishedFeedFixture()
	server := feedRouter(t, resolved, &stubCustomization{}, lister, taxonomies, authors)

	res, body := get(t, server, "/category/news/rss.xml")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "cat_1", lister.filter.CategoryID)
	require.Contains(t, body, "<title>Press · News</title>")

	res, _ = get(t, server, "/tag/go/atom.xml")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "Go", lister.filter.Tag)

	res, _ = get(t, server, "/tag/RSS/rss.xml")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "RSS", lister.filter.Tag)

	res, _ = get(t, server, "/category/missing/rss.xml")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestFeedAcceptsTheQueryScopeAlias(t *testing.T) {
	resolved, lister, taxonomies, authors, _ := publishedFeedFixture()
	server := feedRouter(t, resolved, &stubCustomization{}, lister, taxonomies, authors)

	res, body := get(t, server, "/rss.xml?category=news")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "cat_1", lister.filter.CategoryID)
	require.Contains(t, body, "<title>Press · News</title>")

	res, _ = get(t, server, "/rss.xml?category=news&tag=go")
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
}

func TestFeedReportsStoreFailures(t *testing.T) {
	resolved, _, taxonomies, authors, _ := publishedFeedFixture()
	server := feedRouter(t, resolved, &stubCustomization{}, &feedContentLister{err: errors.New("store down")}, taxonomies, authors)

	res, body := get(t, server, "/rss.xml")
	require.Equal(t, http.StatusInternalServerError, res.StatusCode)
	require.Contains(t, body, "internal")
}
