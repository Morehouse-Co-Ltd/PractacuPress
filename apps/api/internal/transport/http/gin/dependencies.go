// Package ginrouter wires the HTTP transport. It contains no business rules:
// every endpoint delegates to an application service.
package ginrouter

import (
	"context"
	"log/slog"

	"github.com/practacu/practacu-press/apps/api/internal/analytics"
	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/community"
	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/media"
	"github.com/practacu/practacu-press/apps/api/internal/messaging"
	"github.com/practacu/practacu-press/apps/api/internal/notifications"
	"github.com/practacu/practacu-press/apps/api/internal/outbox"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	"github.com/practacu/practacu-press/apps/api/internal/taxonomy"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
	"github.com/practacu/practacu-press/apps/api/internal/transport/ws"
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
	// Auth mounts the authentication endpoints when non nil.
	Auth *auth.Handler
	// Sites mounts the site administration endpoints when non nil.
	Sites *site.Handler
	// Content mounts the article and post endpoints when non nil.
	Content *content.Handler
	// Community mounts the comment and interaction endpoints when non nil.
	Community *community.Handler
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
}

// InstallReporter answers whether a hostname belongs to an installed site.
//
// *site.Service implements it. The interface keeps the transport free of the
// service's repository, which matters here: this endpoint is the one place the API
// answers before a site has been resolved.
type InstallReporter interface {
	InstallStatus(ctx context.Context, hostname string) (site.InstallStatus, error)
}
