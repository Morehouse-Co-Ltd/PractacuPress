package ginrouter

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	"github.com/practacu/practacu-press/apps/api/internal/sitefiles"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// SiteFilesDependencies is what the crawler-facing files need.
//
// Both readers are narrow so the transport does not reach into the site or content
// services directly; main wires the concrete services in, tests wire stubs.
type SiteFilesDependencies struct {
	// Customization reads the site's design document, which carries the SEO switch
	// and the custom page list.
	Customization SiteCustomizationReader
	// Content lists the published items of the resolved site.
	Content sitefiles.ContentLister
}

// SiteCustomizationReader is the site service's read side used by robots.txt and
// sitemap.xml.
type SiteCustomizationReader interface {
	Customization(ctx context.Context, siteID string) (site.Customization, error)
}

// sitemapFile serves /sitemap.xml for the host-resolved site.
func sitemapFile(deps SiteFilesDependencies, trusted middleware.TrustedProxies) gin.HandlerFunc {
	return func(c *gin.Context) {
		resolved, ok := middleware.SiteFrom(c)
		if !ok {
			_ = c.Error(apperr.NotFound("site"))
			return
		}

		seo, pages, err := readSEO(c.Request.Context(), deps, resolved.ID)
		if err != nil {
			_ = c.Error(apperr.Internal(err).WithRequestID(middleware.RequestIDFrom(c)))
			return
		}
		origin := siteOrigin(c, trusted, seo.CanonicalBase)

		// A members-only site publishes no public URLs, so its sitemap is empty and
		// robots.txt disallows everything. Advertising private content IDs would
		// defeat the visibility mode.
		var entries []sitefiles.Entry
		if !resolved.IsMembersOnly() {
			items, listErr := sitefiles.Published(c.Request.Context(), deps.Content, resolved.ID)
			if listErr != nil {
				_ = c.Error(apperr.Internal(listErr).WithRequestID(middleware.RequestIDFrom(c)))
				return
			}
			entries = sitefiles.Build(origin, items, pages)
		}

		c.Header("Cache-Control", "public, max-age=300")
		c.Data(http.StatusOK, "application/xml; charset=utf-8", sitefiles.XML(entries))
	}
}

// robotsFile serves /robots.txt for the host-resolved site.
func robotsFile(deps SiteFilesDependencies, trusted middleware.TrustedProxies) gin.HandlerFunc {
	return func(c *gin.Context) {
		resolved, ok := middleware.SiteFrom(c)
		if !ok {
			_ = c.Error(apperr.NotFound("site"))
			return
		}

		seo, _, err := readSEO(c.Request.Context(), deps, resolved.ID)
		if err != nil {
			_ = c.Error(apperr.Internal(err).WithRequestID(middleware.RequestIDFrom(c)))
			return
		}
		origin := siteOrigin(c, trusted, seo.CanonicalBase)
		// The site owner's indexing switch and the visibility mode both veto crawling.
		indexable := seo.Indexable && !resolved.IsMembersOnly()

		c.Header("Cache-Control", "public, max-age=300")
		c.Data(http.StatusOK, "text/plain; charset=utf-8", sitefiles.Robots(origin, indexable))
	}
}

// readSEO projects the stored design document onto the crawler settings.
//
// A site that never saved a design document is normal (a fresh install), so that
// error is the documented default rather than a failure. Any other read error is
// reported to the caller: a crawl file built from a guess would advertise URLs the
// site cannot serve.
func readSEO(ctx context.Context, deps SiteFilesDependencies, siteID string) (sitefiles.SEO, []sitefiles.Page, error) {
	defaults := sitefiles.SEO{Indexable: true}
	if deps.Customization == nil {
		return defaults, nil, nil
	}

	document, err := deps.Customization.Customization(ctx, siteID)
	if err != nil {
		if errors.Is(err, site.ErrCustomizationNotFound) {
			return defaults, nil, nil
		}
		return defaults, nil, err
	}
	seo, pages := sitefiles.ParseCustomization(document.Document)
	return seo, pages, nil
}

// siteOrigin builds the absolute origin used for sitemap locs and the robots
// Sitemap line.
//
// The operator's canonical base wins, exactly like the frontend SEO layer. Otherwise
// the request Host is used, including its port, so a site served on http://host:8080
// gets locs a crawler can actually reach. Forwarded headers are honoured only from a
// trusted proxy, the same rule the site resolver applies.
func siteOrigin(c *gin.Context, trusted middleware.TrustedProxies, canonicalBase string) string {
	if base := strings.TrimSpace(canonicalBase); base != "" {
		return strings.TrimRight(base, "/")
	}

	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}
	host := c.Request.Host

	if trusted.ContainsRemote(c.Request.RemoteAddr) {
		if forwarded := firstHeaderValue(c.GetHeader("X-Forwarded-Host")); forwarded != "" {
			host = forwarded
		}
		if proto := strings.ToLower(firstHeaderValue(c.GetHeader("X-Forwarded-Proto"))); proto == "http" || proto == "https" {
			scheme = proto
		}
	}

	host = strings.TrimSpace(host)
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

// firstHeaderValue returns the first element of a comma separated forwarding header.
func firstHeaderValue(raw string) string {
	if raw == "" {
		return ""
	}
	return strings.TrimSpace(strings.Split(raw, ",")[0])
}
