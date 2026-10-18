// Command server runs the Practacu Press HTTP API.
//
// It owns process lifecycle only: configuration, logging, the database handle, the
// HTTP server and graceful shutdown. Request handling lives in the transport
// package, business rules live in application services.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/community"
	"github.com/practacu/practacu-press/apps/api/internal/outbox"
	"github.com/practacu/practacu-press/apps/api/internal/media"
		"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/communitystore"
		"github.com/practacu/practacu-press/apps/api/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/outboxstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/mediastore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/securityclient"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/logging"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	ginrouter "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// Timeouts. There is deliberately no global WriteTimeout: WebSocket connections
// are long lived and a server wide write deadline would sever them. Per request
// deadlines are applied by middleware instead.
const (
	startupTimeout  = 15 * time.Second
	shutdownTimeout = 10 * time.Second
)

func main() {
	if err := run(); err != nil {
		logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
		logger.Error("process exited with error", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	logger := logging.New(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	startupCtx, cancelStartup := context.WithTimeout(ctx, startupTimeout)
	defer cancelStartup()

	handle, err := db.Open(startupCtx, cfg.DatabaseDriver, cfg.DatabaseDSN)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer func() {
		if closeErr := handle.Close(); closeErr != nil {
			logger.Error("close database", "error", closeErr)
		}
	}()

	authHandler, issuer, err := buildAuth(cfg, logger, handle)
	if err != nil {
		return err
	}

	// Site resolution is always on: without it every request would fall back to a
	// default site, which breaks tenant isolation the moment a second site exists.
	siteService, err := site.NewService(sitestore.New(handle.Client))
	if err != nil {
		return fmt.Errorf("build site service: %w", err)
	}

	replayer, err := outbox.NewReplayer(outboxstore.New(handle.Client))
	if err != nil {
		return fmt.Errorf("build event replayer: %w", err)
	}

	mediaService, err := media.NewService(media.ServiceConfig{
		Repository: mediastore.New(handle.Client),
		Scanner:    media.UnavailableScanner{},
	})
	if err != nil {
		return fmt.Errorf("build media service: %w", err)
	}

	communityService, err := community.NewService(communitystore.New(handle.Client))
	if err != nil {
		return fmt.Errorf("build community service: %w", err)
	}

	contentService, err := content.NewService(content.ServiceConfig{
		Repository: contentstore.New(handle.Client),
		Sanitizer:  securitySanitizer{client: securityclient.Unavailable{}},
		PublishMode: func(ctx context.Context, siteID string) (site.PublishMode, error) {
			return siteService.PublishMode(ctx, siteID)
		},
	})
	if err != nil {
		return fmt.Errorf("build content service: %w", err)
	}

	router := ginrouter.New(ginrouter.Dependencies{
		Config:       cfg,
		Logger:       logger,
		Readiness:    handle.Ping,
		SiteResolver: siteService,
		AccessTokens: issuer,
		Auth:         authHandler,
		Sites: site.NewHandler(siteService, site.HandlerConfig{
			UserID: func(c *gin.Context) (string, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				return principal.UserID, ok
			},
			RequestID: middleware.RequestIDFrom,
		}),
		Events: outbox.NewEventsHandler(replayer, outbox.HandlerConfig{
			Principal: func(c *gin.Context) (string, string, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return "", "", false
				}
				return principal.SiteID, principal.UserID, true
			},
		}),
		Media: media.NewHandler(mediaService, media.HandlerConfig{
			Principal: func(c *gin.Context) (media.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return media.Actor{}, false
				}
				return media.Actor{UserID: principal.UserID, SiteID: principal.SiteID}, true
			},
		}),
		Community: community.NewHandler(communityService, community.HandlerConfig{
			Principal: func(c *gin.Context) (community.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return community.Actor{}, false
				}
				return community.Actor{
					UserID: principal.UserID,
					SiteID: principal.SiteID,
					Role:   principal.Role,
				}, true
			},
		}),
		Content: content.NewHandler(contentService, content.HandlerConfig{
			Principal: func(c *gin.Context) (content.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return content.Actor{}, false
				}
				return content.Actor{
					UserID: principal.UserID,
					SiteID: principal.SiteID,
					Role:   principal.Role,
				}, true
			},
		}),
	})

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ReadTimeout:       30 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("http server listening",
			"addr", cfg.HTTPAddr,
			"database_driver", handle.Driver(),
		)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	select {
	case err := <-serveErr:
		return fmt.Errorf("http server: %w", err)
	case <-ctx.Done():
		logger.Info("shutdown requested")
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancelShutdown()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	return nil
}

// buildAuth wires the authentication module.
func buildAuth(cfg config.Config, logger *slog.Logger, handle *db.DB) (*auth.Handler, *auth.TokenIssuer, error) {
	issuer, ephemeral, err := auth.NewTokenIssuer(cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("build token issuer: %w", err)
	}
	if ephemeral {
		logger.Warn("using an ephemeral JWT signing key: tokens will not survive a restart " +
			"and will not verify on another replica; set AUTH_JWT_ED25519_PRIVATE_KEY")
	}

	service, err := auth.NewService(auth.ServiceConfig{
		Repository: authstore.New(handle.Client),
		Hasher:     choosePasswordHasher(cfg, logger),
		Tokens:     issuer,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("build auth service: %w", err)
	}

	handler := auth.NewHandler(service, auth.HandlerConfig{
		SecureCookies: cfg.CookieSecure,
		CookieDomain:  cfg.CookieDomain,
		SiteID: func(c *gin.Context) string {
			if resolved, ok := middleware.SiteFrom(c); ok {
				return resolved.ID
			}
			// Windows single site deployments do not configure host resolution.
			return cfg.DefaultSiteID
		},
		Principal: middleware.PrincipalFrom,
	})

	return handler, issuer, nil
}

// securitySanitizer adapts the security service client to the content module's
// narrow Sanitizer port.
//
// The adapter lives at the composition root so neither package has to import the
// other's infrastructure.
type securitySanitizer struct {
	client securityclient.Client
}

// Sanitize delegates sanitization to the security service.
func (s securitySanitizer) Sanitize(
	ctx context.Context,
	format content.SourceFormat,
	source string,
) (content.Sanitized, error) {
	result, err := s.client.SanitizeContent(ctx, securityclient.ContentInput{
		Format: securityclient.ContentFormat(format),
		Source: source,
	})
	if err != nil {
		return content.Sanitized{}, err
	}
	return content.Sanitized{
		HTML:          result.HTML,
		PolicyVersion: result.PolicyVersion,
		Violations:    result.Violations,
	}, nil
}

// choosePasswordHasher picks the password hashing implementation.
//
// Production always delegates to the Rust security service. Until that service is
// deployed the stub fails every call, so a production login fails closed instead of
// silently falling back to a weaker local implementation.
func choosePasswordHasher(cfg config.Config, logger *slog.Logger) auth.PasswordHasher {
	if cfg.AppEnv == config.EnvProduction {
		logger.Info("password hashing delegates to the security service")
		return auth.NewSecurityPasswordHasher(securityclient.Unavailable{})
	}

	logger.Warn("using local Argon2id password hashing: development and test only")
	return auth.NewArgon2idHasher(auth.DefaultArgon2Params())
}
