package ginrouter

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/feed"
	"github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
)

// feedFile serves one syndication feed for the host-resolved site.
//
// The route shape is fixed by the frontend and by feed readers: /rss.xml and
// /atom.xml at the site root, with per-category and per-tag variants below
// /category/{slug}/ and /tag/{slug}/. A site that switched feeds off, a members-only
// site and a site with indexing disabled all answer 404: there is no feed a crawler
// is allowed to read.
func feedFile(
	deps FeedDependencies,
	trusted middleware.TrustedProxies,
	format feed.Format,
	scope feed.Scope,
) gin.HandlerFunc {
	return func(c *gin.Context) {
		resolved, ok := middleware.SiteFrom(c)
		if !ok {
			_ = c.Error(apperr.NotFound("site").WithRequestID(middleware.RequestIDFrom(c)))
			return
		}

		settings, seo, documentUpdatedAt, err := readFeedSettings(c.Request.Context(), deps, resolved.ID)
		if err != nil {
			_ = c.Error(apperr.Internal(err).WithRequestID(middleware.RequestIDFrom(c)))
			return
		}
		if !settings.Enabled || !seo.Indexable || resolved.IsMembersOnly() {
			_ = c.Error(apperr.NotFound("feed").WithRequestID(middleware.RequestIDFrom(c)))
			return
		}

		// The query aliases keep the documented /feed.xml?category=... form working;
		// the path scopes below are the canonical addresses the frontend links to.
		requestScope := scope
		slug := ""
		switch requestScope {
		case feed.ScopeCategory, feed.ScopeTag:
			slug = strings.TrimSpace(c.Param("slug"))
		case feed.ScopeSite:
			category := strings.TrimSpace(c.Query("category"))
			tag := strings.TrimSpace(c.Query("tag"))
			switch {
			case category != "" && tag != "":
				_ = c.Error(apperr.Validation("only one of category or tag may be set").
					WithRequestID(middleware.RequestIDFrom(c)))
				return
			case category != "":
				requestScope, slug = feed.ScopeCategory, category
			case tag != "":
				requestScope, slug = feed.ScopeTag, tag
			}
		}
		if requestScope != feed.ScopeSite {
			if !settings.IncludeTaxonomy {
				_ = c.Error(apperr.NotFound("feed").WithRequestID(middleware.RequestIDFrom(c)))
				return
			}
			if slug == "" {
				_ = c.Error(apperr.NotFound("feed").WithRequestID(middleware.RequestIDFrom(c)))
				return
			}
		}

		origin := siteOrigin(c, trusted, seo.CanonicalBase)
		feedURL := origin + c.Request.URL.RequestURI()
		fallbackUpdated := documentUpdatedAt
		if fallbackUpdated.IsZero() {
			fallbackUpdated = resolved.CreatedAt
		}

		channel, err := feed.Build(c.Request.Context(), feed.Source{
			Content:  deps.Content,
			Taxonomy: deps.Taxonomy,
			Authors:  deps.Authors,
		}, feed.Request{
			SiteID:          resolved.ID,
			SiteName:        resolved.Name,
			SiteDescription: resolved.Description,
			Origin:          origin,
			FeedURL:         feedURL,
			FallbackUpdated: fallbackUpdated,
			Scope:           requestScope,
			Slug:            slug,
			Settings:        settings,
		})
		if err != nil {
			if errors.Is(err, feed.ErrScopeNotFound) {
				_ = c.Error(apperr.NotFound("feed").WithRequestID(middleware.RequestIDFrom(c)))
				return
			}
			_ = c.Error(apperr.Internal(err).WithRequestID(middleware.RequestIDFrom(c)))
			return
		}

		body := feed.Body(channel, format)
		etag := feed.ETag(body)
		c.Header("Cache-Control", "public, max-age=300")
		c.Header("ETag", etag)
		if modified := channel.LastModified(); !modified.IsZero() {
			c.Header("Last-Modified", modified.Format(http.TimeFormat))
		}
		if feed.NotModified(c.Request.Header, etag, channel.Updated) {
			c.Status(http.StatusNotModified)
			return
		}
		c.Data(http.StatusOK, feed.ContentType(format), body)
	}
}

// readFeedSettings projects the stored design document onto the feed settings.
//
// A site that never saved a design document is normal (a fresh install), so that
// error is the documented default. Any other read error is reported: a feed built
// from a guess would advertise content the owner switched off.
func readFeedSettings(
	ctx context.Context,
	deps FeedDependencies,
	siteID string,
) (feed.Settings, feed.SEO, time.Time, error) {
	defaults := feed.Defaults()
	defaultSEO := feed.SEO{Indexable: true}
	if deps.Customization == nil {
		return defaults, defaultSEO, time.Time{}, nil
	}

	document, err := deps.Customization.Customization(ctx, siteID)
	if err != nil {
		if errors.Is(err, site.ErrCustomizationNotFound) {
			return defaults, defaultSEO, time.Time{}, nil
		}
		return defaults, defaultSEO, time.Time{}, err
	}

	settings, seo := feed.ParseCustomization(document.Document)
	return settings, seo, document.UpdatedAt, nil
}
