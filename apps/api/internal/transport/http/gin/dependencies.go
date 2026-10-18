// Package ginrouter wires the HTTP transport. It contains no business rules:
// every endpoint delegates to an application service.
package ginrouter

import (
	"context"
	"log/slog"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
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
	// AccessTokens verifies bearer tokens for guarded routes. Nil disables auth.
	AccessTokens middleware.AccessTokenVerifier
	// Auth mounts the authentication endpoints when non nil.
	Auth *auth.Handler
}
