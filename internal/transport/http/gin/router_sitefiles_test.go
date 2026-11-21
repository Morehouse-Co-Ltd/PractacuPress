package ginrouter

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
)

type stubCustomization struct {
	document []byte
	err      error
}

func (s *stubCustomization) Customization(_ context.Context, _ string) (site.Customization, error) {
	return site.Customization{Document: s.document}, s.err
}

type stubContentLister struct {
	items   []content.Content
	err     error
	siteIDs []string
}

func (s *stubContentLister) ListAfterFilter(
	_ context.Context,
	actor content.Actor,
	_ content.Kind,
	_ int,
	after page.Cursor,
	_ content.ListFilter,
) ([]content.Content, string, error) {
	s.siteIDs = append(s.siteIDs, actor.SiteID)
	if s.err != nil {
		return nil, "", s.err
	}
	if !after.IsZero() {
		return nil, "", nil
	}
	return s.items, "", nil
}

// hostResolver maps hostnames to sites, so a test can prove that one route serves
// different sites (and therefore different sitemaps) per Host.
type hostResolver map[string]site.Site

func (r hostResolver) Resolve(_ context.Context, hostname string) (site.Site, error) {
	resolved, ok := r[hostname]
	if !ok {
		return site.Site{}, site.ErrNotFound
	}
	return resolved, nil
}

func siteFilesRouter(t *testing.T, resolved site.Site, customization *stubCustomization, lister *stubContentLister) *httptest.Server {
	t.Helper()

	resolver := &stubSiteResolver{site: resolved}
	r := testRouter(t, Dependencies{
		Config:       config.Config{AppEnv: config.EnvTest},
		SiteResolver: resolver,
		SiteFiles: SiteFilesDependencies{
			Customization: customization,
			Content:       lister,
		},
	})
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)
	return server
}

func get(t *testing.T, server *httptest.Server, path string) (*http.Response, string) {
	t.Helper()
	return getForHost(t, server, "press.example.com", path)
}

func getForHost(t *testing.T, server *httptest.Server, host, path string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
	require.NoError(t, err)
	req.Host = host

	res, err := server.Client().Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = res.Body.Close() })

	body, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	return res, string(body)
}

func TestSitemapIsServedForTheResolvedHost(t *testing.T) {
	updated := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	lister := &stubContentLister{items: []content.Content{
		{ID: "a1", Kind: content.KindArticle, Status: content.StatusPublished, UpdatedAt: updated},
		{ID: "draft", Kind: content.KindArticle, Status: content.StatusDraft},
	}}
	customization := &stubCustomization{document: []byte(`{
		"pages": [
			{"slug": "about", "status": "published", "updated_at": "2026-11-05T00:00:00Z"},
			{"slug": "private", "status": "draft"}
		]
	}`)}

	server := siteFilesRouter(t, site.Site{ID: "site_1", Name: "Press"}, customization, lister)
	res, body := get(t, server, "/sitemap.xml")

	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, res.Header.Get("Content-Type"), "application/xml")
	require.Contains(t, res.Header.Get("Cache-Control"), "max-age=300")

	require.Contains(t, body, `<loc>http://press.example.com/</loc>`)
	require.Contains(t, body, `<loc>http://press.example.com/a1</loc>`)
	require.Contains(t, body, `<loc>http://press.example.com/about</loc>`)
	require.NotContains(t, body, `<loc>http://press.example.com/draft</loc>`)
	require.NotContains(t, body, `/private`)
	require.Contains(t, body, `<lastmod>2026-11-06</lastmod>`)
	require.Equal(t, []string{"site_1"}, lister.siteIDs)
}

func TestSitemapResolvesOneSitePerHost(t *testing.T) {
	lister := &stubContentLister{}
	r := testRouter(t, Dependencies{
		Config: config.Config{AppEnv: config.EnvTest},
		SiteResolver: hostResolver{
			"a.example.com": {ID: "site_a", Name: "A"},
			"b.example.com": {ID: "site_b", Name: "B"},
		},
		SiteFiles: SiteFilesDependencies{
			Customization: &stubCustomization{},
			Content:       lister,
		},
	})
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	_, first := getForHost(t, server, "a.example.com", "/sitemap.xml")
	require.Contains(t, first, `<loc>http://a.example.com/</loc>`)

	_, second := getForHost(t, server, "b.example.com", "/sitemap.xml")
	require.Contains(t, second, `<loc>http://b.example.com/</loc>`)
	require.NotContains(t, second, "a.example.com")

	require.Equal(t, []string{"site_a", "site_b"}, lister.siteIDs)

	res, _ := getForHost(t, server, "unknown.example.com", "/sitemap.xml")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestSitemapUsesTheConfiguredCanonicalBase(t *testing.T) {
	lister := &stubContentLister{}
	customization := &stubCustomization{document: []byte(`{
		"seo": {"canonical_base": "https://press.example.com/"}
	}`)}

	server := siteFilesRouter(t, site.Site{ID: "site_1"}, customization, lister)
	_, body := get(t, server, "/sitemap.xml")

	require.Contains(t, body, `<loc>https://press.example.com/</loc>`)
	require.Contains(t, body, `<loc>https://press.example.com/articles</loc>`)
}

func TestRobotsPointsAtTheServerSitemap(t *testing.T) {
	server := siteFilesRouter(t,
		site.Site{ID: "site_1"},
		&stubCustomization{},
		&stubContentLister{},
	)
	res, body := get(t, server, "/robots.txt")

	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, res.Header.Get("Content-Type"), "text/plain")
	require.Contains(t, body, "Sitemap: http://press.example.com/sitemap.xml")
	require.Contains(t, body, "Disallow: /admin")
}

func TestRobotsDisallowsEverythingWhenIndexingIsOff(t *testing.T) {
	server := siteFilesRouter(t,
		site.Site{ID: "site_1"},
		&stubCustomization{document: []byte(`{"seo": {"indexable": false}}`)},
		&stubContentLister{},
	)
	_, body := get(t, server, "/robots.txt")

	require.Equal(t, "User-agent: *\nDisallow: /\n", body)
}

func TestMembersOnlySiteExposesNoCrawlableContent(t *testing.T) {
	lister := &stubContentLister{items: []content.Content{
		{ID: "a1", Kind: content.KindArticle, Status: content.StatusPublished},
	}}
	server := siteFilesRouter(t,
		site.Site{ID: "site_1", VisibilityMode: site.VisibilityMembersOnly},
		&stubCustomization{},
		lister,
	)

	_, sitemap := get(t, server, "/sitemap.xml")
	require.NotContains(t, sitemap, "/a1")

	_, robots := get(t, server, "/robots.txt")
	require.Equal(t, "User-agent: *\nDisallow: /\n", robots)
}

func TestSiteFilesWithoutASavedDesignFallBackToDefaults(t *testing.T) {
	server := siteFilesRouter(t,
		site.Site{ID: "site_1"},
		&stubCustomization{err: site.ErrCustomizationNotFound},
		&stubContentLister{},
	)
	_, body := get(t, server, "/robots.txt")

	require.Contains(t, body, "Allow: /")
}

func TestSiteFilesReportListFailures(t *testing.T) {
	server := siteFilesRouter(t,
		site.Site{ID: "site_1"},
		&stubCustomization{},
		&stubContentLister{err: errors.New("store down")},
	)
	res, body := get(t, server, "/sitemap.xml")

	require.Equal(t, http.StatusInternalServerError, res.StatusCode)
	require.Contains(t, body, "internal")
}

func TestAPIDocsPageAndAssetsAreSelfHosted(t *testing.T) {
	r := testRouter(t, Dependencies{})
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	res, page := get(t, server, "/api/v1/docs")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, res.Header.Get("Content-Type"), "text/html")
	require.Contains(t, page, "/api/v1/docs/app.js")

	res, css := get(t, server, "/api/v1/docs/app.css")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, res.Header.Get("Content-Type"), "text/css")
	require.Contains(t, css, ".op-path")

	res, script := get(t, server, "/api/v1/docs/app.js")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, res.Header.Get("Content-Type"), "text/javascript")
	require.Contains(t, script, "openapi.json")
}
