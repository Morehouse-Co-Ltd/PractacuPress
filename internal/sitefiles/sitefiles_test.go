package sitefiles_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/permalink"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/sitefiles"
)

func TestBuildListsPublicRoutesAndPublishedEntries(t *testing.T) {
	updated := time.Date(2026, 11, 6, 10, 30, 0, 0, time.UTC)
	entries := sitefiles.Build("https://press.example.com/", []sitefiles.Item{
		{ID: "a1", Slug: "hello-world", Kind: content.KindArticle, UpdatedAt: updated},
		{ID: "p1", Slug: "release-notes", Kind: content.KindPost, UpdatedAt: updated},
		{ID: "legacy", Kind: content.KindArticle, UpdatedAt: updated},
		{ID: "canon", Slug: "local", Kind: content.KindArticle, CanonicalURL: "https://elsewhere.example/post", UpdatedAt: updated},
		{ID: "unknown", Slug: "no-page", Kind: content.Kind("page"), UpdatedAt: updated},
		{ID: "", Kind: content.KindArticle},
	}, []sitefiles.Page{
		{Slug: "about", Status: "published", UpdatedAt: "2026-11-01T08:00:00Z"},
		{Slug: "draft-page", Status: "draft", UpdatedAt: "2026-11-01T08:00:00Z"},
		{Slug: "", Status: "published"},
	})

	locations := make([]string, 0, len(entries))
	for _, entry := range entries {
		locations = append(locations, entry.Loc)
	}

	// J5: the slug is the permalink, the id is only the fallback for legacy content,
	// and an author supplied canonical URL wins over both.
	require.Equal(t, []string{
		"https://press.example.com/",
		"https://press.example.com/articles",
		"https://press.example.com/posts",
		"https://press.example.com/hello-world",
		"https://press.example.com/release-notes",
		"https://press.example.com/legacy",
		"https://elsewhere.example/post",
		"https://press.example.com/about",
	}, locations)

	require.Equal(t, "2026-11-06", entries[3].LastModified)
	require.Equal(t, "2026-11-06", entries[6].LastModified)
	require.Equal(t, "2026-11-01", entries[7].LastModified)
}

func TestBuildEscapesSlugsAndLocations(t *testing.T) {
	entries := sitefiles.Build("https://press.example.com?a=1&b=2", nil, []sitefiles.Page{
		{Slug: "a b/c", Status: "published", UpdatedAt: "2026-11-01"},
	})

	body := string(sitefiles.XML(entries))
	require.Contains(t, body, `<loc>https://press.example.com?a=1&amp;b=2/a%20b%2Fc</loc>`)

	entries = sitefiles.Build("https://press.example.com", nil, []sitefiles.Page{
		{Slug: "a b/c", Status: "published", UpdatedAt: "2026-11-01"},
	})
	body = string(sitefiles.XML(entries))
	require.Contains(t, body, `<loc>https://press.example.com/a%20b%2Fc</loc>`)
}

func TestBuildUsesConfiguredPermalinkStructure(t *testing.T) {
	published := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	settings := permalink.Defaults()
	settings.ArticleStructure = permalink.StructureMonthName
	entries := sitefiles.Build("https://press.example.com", []sitefiles.Item{{
		ID: "a1", Slug: "hello-world", Kind: content.KindArticle,
		PublishedAt: published, CreatedAt: published,
	}}, nil, settings)

	require.Equal(t, "https://press.example.com/2026/11/hello-world", entries[3].Loc)
}

func TestXMLIsWellFormedAndKeepsPriority(t *testing.T) {
	body := sitefiles.XML(sitefiles.Build("https://press.example.com", nil, nil))

	require.Contains(t, string(body), `<?xml version="1.0" encoding="UTF-8"?>`)
	require.Contains(t, string(body), `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`)
	require.Contains(t, string(body), "<priority>1.0</priority>")
	require.Contains(t, string(body), "<changefreq>daily</changefreq>")
	require.NotContains(t, string(body), "&lt;")
}

func TestRobotsDisallowsEverythingWhenNotIndexable(t *testing.T) {
	body := string(sitefiles.Robots("https://press.example.com", false))
	require.Equal(t, "User-agent: *\nDisallow: /\n", body)
}

func TestRobotsPointsAtTheServerSitemap(t *testing.T) {
	body := string(sitefiles.Robots("https://press.example.com/", true))
	require.Contains(t, body, "Disallow: /admin\n")
	require.Contains(t, body, "Sitemap: https://press.example.com/sitemap.xml\n")
	require.NotContains(t, body, "//sitemap.xml")
}

func TestParseCustomizationDefaultsAndOverrides(t *testing.T) {
	seo, pages := sitefiles.ParseCustomization(nil)
	require.True(t, seo.Indexable)
	require.Empty(t, seo.CanonicalBase)
	require.Empty(t, pages)

	seo, pages = sitefiles.ParseCustomization([]byte(`{
		"seo": {"indexable": false, "canonical_base": "https://press.example.com/"},
		"pages": [{"slug": "about", "status": "published", "updated_at": "2026-11-01T00:00:00Z"}]
	}`))
	require.False(t, seo.Indexable)
	require.Equal(t, "https://press.example.com", seo.CanonicalBase)
	require.Len(t, pages, 1)
	require.Equal(t, "about", pages[0].Slug)

	// A malformed document keeps the safe defaults; it must not take the sitemap down.
	seo, pages = sitefiles.ParseCustomization([]byte(`{`))
	require.True(t, seo.Indexable)
	require.Empty(t, pages)
}

// fakeLister returns two pages of content for the first call and nothing afterwards.
type fakeLister struct {
	calls   int
	cursors []page.Cursor
}

func (f *fakeLister) ListAfterFilter(
	_ context.Context,
	actor content.Actor,
	_ content.Kind,
	_ int,
	after page.Cursor,
	_ content.ListFilter,
) ([]content.Content, string, error) {
	f.calls++
	f.cursors = append(f.cursors, after)
	if f.calls == 1 {
		return []content.Content{
			{
				ID: "a1", Slug: "hello-world", Kind: content.KindArticle,
				Status: content.StatusPublished, CanonicalURL: "https://elsewhere.example/a1",
			},
			{ID: "draft", Kind: content.KindArticle, Status: content.StatusDraft},
		}, page.Cursor{Key: "2026-11-06T00:00:00Z", ID: "a1"}.Encode(), nil
	}
	return []content.Content{{ID: "p1", Kind: content.KindPost, Status: content.StatusPublished}}, "", nil
}

func TestPublishedPaginatesAndKeepsOnlyPublishedItems(t *testing.T) {
	lister := &fakeLister{}
	items, err := sitefiles.Published(context.Background(), lister, "site_1")
	require.NoError(t, err)
	require.Len(t, items, 2)
	require.Equal(t, "a1", items[0].ID)
	require.Equal(t, "hello-world", items[0].Slug)
	require.Equal(t, "https://elsewhere.example/a1", items[0].CanonicalURL)
	require.Equal(t, "p1", items[1].ID)
	require.Equal(t, 2, lister.calls)
	require.Equal(t, "a1", lister.cursors[1].ID)
}

func TestPublishedWithoutStoreIsEmpty(t *testing.T) {
	items, err := sitefiles.Published(context.Background(), nil, "site_1")
	require.NoError(t, err)
	require.Empty(t, items)

	items, err = sitefiles.Published(context.Background(), &fakeLister{}, "")
	require.NoError(t, err)
	require.Empty(t, items)
}
