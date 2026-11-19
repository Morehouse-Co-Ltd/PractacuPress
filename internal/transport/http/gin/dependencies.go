// Package ginrouter wires the HTTP transport. It contains no business rules:
// every endpoint delegates to an application service.
package ginrouter

import (
	"context"
	"log/slog"

	"github.com/practacu/practacu-press/internal/analytics"
	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/backup"
	"github.com/practacu/practacu-press/internal/captcha"
	"github.com/practacu/practacu-press/internal/community"
	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/extensions"
	"github.com/practacu/practacu-press/internal/feed"
	"github.com/practacu/practacu-press/internal/media"
	"github.com/practacu/practacu-press/internal/messaging"
	"github.com/practacu/practacu-press/internal/moderation"
	"github.com/practacu/practacu-press/internal/newsletter"
	"github.com/practacu/practacu-press/internal/notifications"
	"github.com/practacu/practacu-press/internal/observability"
	"github.com/practacu/practacu-press/internal/outbox"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/platformadmin"
	"github.com/practacu/practacu-press/internal/plugins"
	"github.com/practacu/practacu-press/internal/redirect"
	"github.com/practacu/practacu-press/internal/safety"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/system"
	"github.com/practacu/practacu-press/internal/taxonomy"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
	"github.com/practacu/practacu-press/internal/transport/ws"
)

// Dependencies is everything the HTTP layer needs.
//
// Handlers never reach for process globals; anything they need arrives from the
// composition root in main.
type Dependencies struct {
	// Config is the validated process configuration.
	Config config.Config
	// Logger is the structured process logger. A nil logger is replaced by a
	// discard logger so tests need not supply one.
	Logger *slog.Logger
	// Readiness reports whether the process can serve traffic. A nil func means
	// "always ready", which is the correct default before the data layer exists.
	Readiness func(ctx context.Context) error
	// SiteResolver resolves the request hostname to a site. Nil disables host
	// resolution, which is correct until the site service exists.
	SiteResolver middleware.SiteResolver
	// Install reports whether the request hostname still has an installed site.
	//
	// It is the only site aware endpoint mounted outside the resolver group: the
	// wizard needs an answer precisely when no site resolves, which the group would
	// turn into a 404 before any handler runs. Nil reports "not configured".
	Install InstallReporter
	// AccessTokens verifies bearer tokens for guarded routes. Nil disables auth.
	AccessTokens middleware.AccessTokenVerifier
	// Memberships resolves the live membership of an authenticated caller. When set,
	// every guarded request uses the database role instead of the token's role claim,
	// so demotion, suspension and removal take effect immediately. Nil keeps the
	// token-only behaviour (used by tests that do not model membership).
	Memberships middleware.MembershipResolver
	// Auth mounts the authentication endpoints when non nil.
	Auth *auth.Handler
	// OAuth mounts the third party login endpoints when non nil. Nil means no
	// provider has client credentials, which is the ordinary state of an install
	// that only offers password login; the routes are then simply absent.
	OAuth *auth.OAuthHandler
	// Captcha mounts the public human verification status endpoint when non nil.
	// It is public because the login and registration forms need to know whether a
	// widget is required before a session exists.
	Captcha *captcha.Handler
	// Audit mounts the audit query endpoint when non nil.
	Audit *audit.Handler
	// Sites mounts the site administration endpoints when non nil.
	Sites *site.Handler
	// Backups mounts the instance backup and site export/import endpoints when
	// non nil.
	Backups *backup.Handler
	// StepUp enforces the per-site re-authentication switch on the high threat
	// routes (account administration, site import, policy deletion). A nil enforcer
	// leaves every route unchanged, which is what the contract tests rely on.
	StepUp StepUpDependencies
	// Platform mounts the deployment level site console when non nil.
	Platform *platformadmin.Handler
	// Content mounts the article and post endpoints when non nil.
	Content *content.Handler
	// Community mounts the comment and interaction endpoints when non nil.
	Community *community.Handler
	// Reports mounts the community report queue when non nil.
	Reports *moderation.Handler
	// Media mounts the upload endpoints when non nil.
	Media *media.Handler
	// WS mounts the ticket endpoint and the socket when non nil.
	WS *ws.Handler
	// Messages mounts the conversation endpoints when non nil.
	Messages *messaging.Handler
	// Notifications mounts the inbox endpoints when non nil.
	Notifications *notifications.Handler
	// Events mounts the catch up endpoint when non nil.
	Events *outbox.EventsHandler
	// Analytics mounts the page view and traffic report endpoints when non nil.
	Analytics *analytics.Handler
	// Taxonomy mounts the category and tag endpoints when non nil.
	Taxonomy *taxonomy.Handler
	// Safety mounts the sensitive word, IP rule and comment frequency endpoints when
	// non nil.
	Safety *safety.Handler
	// IPPolicy enforces the host-resolved site's IP allow and deny lists. Nil leaves
	// every site open, which is the documented default.
	IPPolicy middleware.IPPolicyChecker
	// SiteFiles renders /sitemap.xml and /robots.txt. Both readers must be set for the
	// routes to be mounted: a sitemap built from a missing content store would be a
	// lie, and an absent capability is better than an empty promise.
	SiteFiles SiteFilesDependencies
	// Feed renders the RSS and Atom feeds. The customization and content readers are
	// required for the routes to be mounted; taxonomy and author lookup are optional
	// and only enrich the output.
	Feed FeedDependencies
	// Plugins is the optional plugin host. Nil keeps the process exactly as it was
	// before plugins existed: no plugin routes, no boot manifest, and the shipped
	// contract is served unchanged.
	Plugins *plugins.Host
	// Extensions is the optional extension administration endpoint. Nil keeps the
	// management routes out of the process; the host above still serves whatever it
	// already has installed.
	Extensions *extensions.Handler
	// System mounts the optional resource panel (host and per-process metrics) when
	// non nil. Nil leaves the whole module — route and sampler — out of the process.
	System *system.Handler
	// SiteCORSOrigins resolves the per-site allowed origins recorded in site
	// configuration. It is a function rather than a list because the answer belongs to
	// the resolved site, which only exists after middleware.ResolveSite ran. Nil keeps
	// the site level CORS layer out of the process, leaving the deployment wide policy
	// in charge exactly as before Beta 1.2.
	SiteCORSOrigins func(ctx context.Context, siteID string) ([]string, error)
	// Redirect mounts the public path resolver and the site level redirect rules.
	// Nil keeps both out of the process, which is what the contract tests without a
	// database rely on.
	Redirect *redirect.Handler
	// RequestLog is the bounded request metadata ring buffer behind the operator
	// console. Nil disables both the recorder middleware and the log endpoint.
	RequestLog *observability.Recorder
	// Ops mounts the request log, queue view and manual retry endpoints.
	Ops *system.OpsHandler
	// BackupSchedule mounts the automatic backup status endpoint.
	BackupSchedule *backup.ScheduleHandler
	// Newsletter mounts the public subscription endpoints, the account preference and
	// the site level subscriber, template, log and send endpoints.
	Newsletter *newsletter.Handler
}

// FeedDependencies is what the syndication feeds need.
//
// The readers are narrow on purpose: the transport does not reach into the content,
// site or taxonomy services directly, and tests can wire stubs without a database.
type FeedDependencies struct {
	Customization SiteCustomizationReader
	Content       feed.ContentLister
	Taxonomy      feed.TaxonomyLister
	Authors       feed.AuthorLookup
}

// InstallReporter answers whether a hostname belongs to an installed site.
//
// *site.Service implements it. The interface keeps the transport free of the
// service's repository, which matters here: this endpoint is the one place the API
// answers before a site has been resolved.
type InstallReporter interface {
	InstallStatus(ctx context.Context, hostname string) (site.InstallStatus, error)
}
