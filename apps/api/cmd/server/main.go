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

	"github.com/practacu/practacu-press/apps/api/internal/analytics"
	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/community"
	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/analyticsstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/communitystore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/mediastore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/messagingstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/notificationstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/outboxstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/securityclient"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/taxonomystore"
	"github.com/practacu/practacu-press/apps/api/internal/media"
	"github.com/practacu/practacu-press/apps/api/internal/messaging"
	"github.com/practacu/practacu-press/apps/api/internal/notifications"
	"github.com/practacu/practacu-press/apps/api/internal/outbox"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/logging"
	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	"github.com/practacu/practacu-press/apps/api/internal/taxonomy"
	ginrouter "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
	"github.com/practacu/practacu-press/apps/api/internal/transport/ws"
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
	handle.ConfigurePool(cfg.DBMaxOpenConns, cfg.DBMaxIdleConns, cfg.DBConnMaxLifetime)
	defer func() {
		if closeErr := handle.Close(); closeErr != nil {
			logger.Error("close database", "error", closeErr)
		}
	}()

	securityClient, closeSecurity := dialSecurity(ctx, cfg, logger)
	defer closeSecurity()

	// The Windows launcher starts this process against an empty SQLite file. Making
	// the database usable is part of startup there, not a separate operator step:
	// without a site the setup wizard has nothing to configure.
	if cfg.DesktopMode {
		siteID, err := bootstrapDesktop(startupCtx, handle, logger)
		if err != nil {
			return fmt.Errorf("desktop bootstrap: %w", err)
		}
		if cfg.DefaultSiteID == "" {
			cfg.DefaultSiteID = siteID
		}
	}

	authHandler, issuer, err := buildAuth(cfg, logger, handle, securityClient)
	if err != nil {
		return err
	}

	// Site resolution is always on: without it every request would fall back to a
	// default site, which breaks tenant isolation the moment a second site exists.
	// In production a single site without a domain only answers on a public IP
	// literal; development, tests and the desktop launcher keep the permissive
	// fallback so localhost still works.
	siteService, err := site.NewService(
		sitestore.New(handle.Client),
		site.RequirePublicAddress(cfg.AppEnv == config.EnvProduction && !cfg.DesktopMode),
	)
	if err != nil {
		return fmt.Errorf("build site service: %w", err)
	}

	replayer, err := outbox.NewReplayer(outboxstore.New(handle.Client))
	if err != nil {
		return fmt.Errorf("build event replayer: %w", err)
	}

	mediaStorage, mediaStorages, err := buildStorage(startupCtx, cfg, logger)
	if err != nil {
		return fmt.Errorf("open media storage: %w", err)
	}

	mediaService, err := media.NewService(media.ServiceConfig{
		Repository: mediastore.New(handle.Client),
		Scanner:    securityScanner{client: securityClient},
		Storage:    mediaStorage,
		Storages:   mediaStorages,
	})
	if err != nil {
		return fmt.Errorf("build media service: %w", err)
	}

	communityStore := communitystore.New(handle.Client)
	communityService, err := community.NewService(communityStore, communityStore)
	if err != nil {
		return fmt.Errorf("build community service: %w", err)
	}

	hub := ws.NewHub()
	tickets := ws.NewTicketStore(nil)

	// The worker turns committed outbox rows into live pushes. Delivery stays best
	// effort: a missed push is recovered through GET /events, which is authoritative.
	worker, err := outbox.NewWorker(outbox.Config{
		Repository: outboxstore.New(handle.Client),
		Handler:    outboxHandler{hub: hub},
	})
	if err != nil {
		return fmt.Errorf("build outbox worker: %w", err)
	}
	go runOutbox(ctx, logger, worker)

	messageService, err := messaging.NewService(messagingstore.New(handle.Client))
	if err != nil {
		return fmt.Errorf("build messaging service: %w", err)
	}

	notificationService, err := notifications.NewService(notificationstore.New(handle.Client))
	if err != nil {
		return fmt.Errorf("build notification service: %w", err)
	}

	contentService, err := content.NewService(content.ServiceConfig{
		Repository: contentstore.New(handle.Client),
		Sanitizer:  securitySanitizer{client: securityClient},
		PublishMode: func(ctx context.Context, siteID string) (site.PublishMode, error) {
			return siteService.PublishMode(ctx, siteID)
		},
	})
	if err != nil {
		return fmt.Errorf("build content service: %w", err)
	}

	analyticsService, err := analytics.NewService(analytics.ServiceConfig{
		Repository: analyticsstore.New(handle.Client),
	})
	if err != nil {
		return fmt.Errorf("build analytics service: %w", err)
	}

	taxonomyService, err := taxonomy.NewService(taxonomy.ServiceConfig{
		Repository: taxonomystore.New(handle.Client),
	})
	if err != nil {
		return fmt.Errorf("build taxonomy service: %w", err)
	}

	router := ginrouter.New(ginrouter.Dependencies{
		Config:       cfg,
		Logger:       logger,
		Readiness:    handle.Ping,
		SiteResolver: siteService,
		Install:      siteService,
		AccessTokens: issuer,
		Auth:         authHandler,
		Sites: site.NewHandler(siteService, site.HandlerConfig{
			Principal: func(c *gin.Context) (string, string, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				return principal.UserID, principal.SiteID, ok
			},
			Site: func(c *gin.Context) (site.Site, bool) {
				return middleware.SiteFrom(c)
			},
			RequestID: middleware.RequestIDFrom,
		}),
		WS: ws.NewHandler(tickets, hub, ws.HandlerConfig{
			Principal: func(c *gin.Context) (string, string, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return "", "", false
				}
				return principal.SiteID, principal.UserID, true
			},
			OriginPatterns: cfg.CORSAllowedOrigins,
		}),
		Messages: messaging.NewHandler(messageService, messaging.HandlerConfig{
			Principal: func(c *gin.Context) (messaging.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return messaging.Actor{}, false
				}
				return messaging.Actor{
					UserID: principal.UserID,
					SiteID: principal.SiteID,
					Role:   principal.Role,
				}, true
			},
		}),
		Notifications: notifications.NewHandler(notificationService, notifications.HandlerConfig{
			Principal: func(c *gin.Context) (notifications.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return notifications.Actor{}, false
				}
				return notifications.Actor{UserID: principal.UserID, SiteID: principal.SiteID}, true
			},
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
			// Anonymous downloads are scoped by the resolved host; uploads never are.
			Site: func(c *gin.Context) (site.Site, bool) { return middleware.SiteFrom(c) },
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
			Site: func(c *gin.Context) (site.Site, bool) { return middleware.SiteFrom(c) },
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
			Site: func(c *gin.Context) (site.Site, bool) { return middleware.SiteFrom(c) },
		}),
		Analytics: analytics.NewHandler(analyticsService, analytics.HandlerConfig{
			Principal: func(c *gin.Context) (analytics.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return analytics.Actor{}, false
				}
				return analytics.Actor{
					UserID: principal.UserID,
					SiteID: principal.SiteID,
					Role:   principal.Role,
				}, true
			},
			Site: func(c *gin.Context) (site.Site, bool) { return middleware.SiteFrom(c) },
		}),
		Taxonomy: taxonomy.NewHandler(taxonomyService, taxonomy.HandlerConfig{
			Principal: func(c *gin.Context) (taxonomy.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return taxonomy.Actor{}, false
				}
				return taxonomy.Actor{
					UserID: principal.UserID,
					SiteID: principal.SiteID,
					Role:   principal.Role,
				}, true
			},
			Site: func(c *gin.Context) (site.Site, bool) { return middleware.SiteFrom(c) },
		}),
	})

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       cfg.HTTPIdleTimeout,
		ReadTimeout:       cfg.HTTPReadTimeout,
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
func buildAuth(cfg config.Config, logger *slog.Logger, handle *db.DB, security securityclient.Client) (*auth.Handler, *auth.TokenIssuer, error) {
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
		Hasher:     choosePasswordHasher(cfg, logger, security),
		Tokens:     issuer,
		// A desktop install has no operator console to promote its first account,
		// so registration does it once. Every other deployment keeps plain members.
		BootstrapFirstAdmin: cfg.DesktopMode,
		Mailer:              buildMailer(cfg, logger),
		PublicBaseURL:       cfg.PublicBaseURL,
		Logger:              logger,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("build auth service: %w", err)
	}

	handler := auth.NewHandler(service, auth.HandlerConfig{
		SecureCookies: cfg.CookieSecure,
		CookieDomain:  cfg.CookieDomain,
		// Credential endpoints get a second, tighter budget than the global one: a
		// login burst must not be able to saturate the Argon2 path in the security
		// service, and password guessing benefits from being slow.
		CredentialLimiter: buildCredentialLimiter(cfg),
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

// buildCredentialLimiter returns the per client budget for password consuming
// endpoints, or nil when the tier is disabled.
//
// It uses its own store on purpose: sharing the global store would make a burst of
// ordinary requests spend the credential budget, and a login attempt spend the browsing
// budget.
func buildCredentialLimiter(cfg config.Config) gin.HandlerFunc {
	if cfg.CredentialRateLimitPerMinute <= 0 {
		return nil
	}
	return middleware.RateLimit(
		middleware.NewMemoryRateLimitStore(nil),
		middleware.Policy{Limit: cfg.CredentialRateLimitPerMinute, Window: time.Minute},
	)
}

// buildMailer returns the SMTP sender, or nil when no relay is configured.
//
// Nil is meaningful rather than lazy: the auth service reports password reset as
// unavailable instead of accepting requests it cannot deliver.
func buildMailer(cfg config.Config, logger *slog.Logger) mailer.Sender {
	if cfg.SMTPHost == "" {
		logger.Info("SMTP is not configured: password reset is disabled")
		return nil
	}
	sender, err := mailer.New(mailer.Config{
		Host:       cfg.SMTPHost,
		Port:       cfg.SMTPPort,
		Encryption: cfg.SMTPEncryption,
		Username:   cfg.SMTPUsername,
		Password:   cfg.SMTPPassword,
		From:       cfg.SMTPFrom,
		FromName:   cfg.SMTPFromName,
	})
	if err != nil {
		// Config.Load already validated these values; reaching here means a caller
		// assembled Config by hand, which is a programming error worth failing on.
		panic(fmt.Sprintf("build mailer: %v", err))
	}
	logger.Info("SMTP relay configured",
		"host", cfg.SMTPHost,
		"port", cfg.SMTPPort,
		"encryption", cfg.SMTPEncryption,
		"from", cfg.SMTPFrom,
	)
	return sender
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
func choosePasswordHasher(cfg config.Config, logger *slog.Logger, security securityclient.Client) auth.PasswordHasher {
	if _, unavailable := security.(securityclient.Unavailable); !unavailable {
		logger.Info("password hashing delegates to the security service")
		return auth.NewSecurityPasswordHasher(security)
	}

	if cfg.AppEnv == config.EnvProduction {
		// No local fallback in production: an unreachable service must fail closed.
		logger.Warn("security service unreachable; password operations fail closed")
		return auth.NewSecurityPasswordHasher(securityclient.Unavailable{})
	}

	logger.Warn("using local Argon2id password hashing: development and test only")
	return auth.NewArgon2idHasher(auth.DefaultArgon2Params())
}

// dialSecurity connects to the security service.
//
// A failed connection is not fatal: the API keeps serving and every operation that
// needs a security verdict fails closed, which is the behaviour the design asks for
// during an outage.
func dialSecurity(ctx context.Context, cfg config.Config, logger *slog.Logger) (securityclient.Client, func()) {
	dialCtx, cancel := context.WithTimeout(ctx, startupTimeout)
	defer cancel()

	client, err := securityclient.Dial(dialCtx, securityclient.GRPCConfig{Addr: cfg.SecurityGRPCAddr})
	if err != nil {
		logger.Warn("security service unavailable; content publishing and uploads will be held",
			"addr", cfg.SecurityGRPCAddr, "error", err)
		return securityclient.Unavailable{}, func() {}
	}

	if pingErr := client.Ping(dialCtx); pingErr != nil {
		logger.Warn("security service did not answer; content publishing and uploads will be held",
			"addr", cfg.SecurityGRPCAddr, "error", pingErr)
		_ = client.Close()
		return securityclient.Unavailable{}, func() {}
	}

	logger.Info("security service connected", "addr", cfg.SecurityGRPCAddr)
	return client, func() { _ = client.Close() }
}

// securityScanner adapts the security client to the media module's Scanner port.
type securityScanner struct {
	client securityclient.Client
}

// Inspect delegates upload inspection to the security service.
func (s securityScanner) Inspect(ctx context.Context, in media.ScanInput) (media.ScanResult, error) {
	result, err := s.client.InspectUpload(ctx, securityclient.UploadInput{
		FileName:     in.FileName,
		DeclaredMIME: in.DeclaredMIME,
		Size:         in.Size,
		StorageKey:   in.StorageKey,
		Content:      in.Head,
	})
	if err != nil {
		return media.ScanResult{}, err
	}
	return media.ScanResult{
		Status:     media.ScanStatus(result.Status),
		ReasonCode: result.ReasonCode,
	}, nil
}

// outboxHandler forwards a published event to live subscribers.
type outboxHandler struct {
	hub *ws.Hub
}

// Handle implements outbox.Handler.
func (h outboxHandler) Handle(ctx context.Context, event outbox.Event) error {
	occurred := time.Now().UTC()
	if raw, ok := event.Payload["occurred_at"].(string); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			occurred = parsed
		}
	}

	h.hub.Publish(ctx, ws.Event{
		ID:             event.EventID,
		Type:           event.Type,
		OccurredAt:     occurred,
		SiteID:         event.SiteID,
		AudienceUserID: event.AudienceUserID,
		Payload:        event.Payload,
	})
	return nil
}

// runOutbox drains the outbox on a fixed interval until the process stops.
func runOutbox(ctx context.Context, logger *slog.Logger, worker *outbox.Worker) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			result, err := worker.RunOnce(ctx, outbox.DefaultBatch)
			if err != nil {
				logger.Error("outbox pass failed", "error", err)
				continue
			}
			if result.Claimed > 0 {
				logger.Info("outbox pass",
					"claimed", result.Claimed,
					"published", result.Published,
					"failed", result.Failed,
				)
			}
		}
	}
}

// buildStorage selects the media storage implementations.
//
// It returns the global adapter plus an optional override per media purpose. Both
// implementations satisfy the same port, so nothing downstream knows which one is in
// use; the choice stays a deployment concern. A purpose without an override (driver
// inherit) is simply absent from the map and falls back to the global adapter.
func buildStorage(ctx context.Context, cfg config.Config, logger *slog.Logger) (media.Storage, map[media.Purpose]media.Storage, error) {
	global, err := buildStorageAdapter(ctx, cfg, cfg.StorageDriver, cfg.StorageDir, cfg.S3Bucket, cfg.S3Prefix, "", logger)
	if err != nil {
		return nil, nil, err
	}

	overrides := make(map[media.Purpose]media.Storage)
	for _, scope := range config.StorageScopeNames() {
		scopeCfg := cfg.StorageScopes[scope]
		if scopeCfg.Driver == "" || scopeCfg.Driver == config.StorageDriverInherit {
			continue
		}

		store, buildErr := buildStorageAdapter(
			ctx, cfg, scopeCfg.Driver, scopeCfg.LocalDir, scopeCfg.S3Bucket, scopeCfg.S3Prefix, scope, logger,
		)
		if buildErr != nil {
			return nil, nil, fmt.Errorf("%s storage: %w", scope, buildErr)
		}
		overrides[media.Purpose(scope)] = store
	}

	return global, overrides, nil
}

// buildStorageAdapter constructs one adapter. scope is empty for the global adapter and
// only used for logging.
func buildStorageAdapter(
	ctx context.Context,
	cfg config.Config,
	driver, localDir, bucket, prefix, scope string,
	logger *slog.Logger,
) (media.Storage, error) {
	attributes := []any{}
	if scope != "" {
		attributes = append(attributes, "scope", scope)
	}

	switch driver {
	case config.StorageDriverS3:
		store, err := media.NewS3Storage(ctx, media.S3Config{
			Bucket:    bucket,
			Region:    cfg.S3Region,
			Endpoint:  cfg.S3Endpoint,
			AccessKey: cfg.S3AccessKey,
			SecretKey: cfg.S3SecretKey,
			Prefix:    prefix,
		})
		if err != nil {
			return nil, err
		}
		logger.Info("media storage ready", append(attributes, "driver", "s3", "bucket", store.Bucket())...)
		return store, nil

	case config.StorageDriverLocal:
		store, err := media.NewLocalStorage(localDir)
		if err != nil {
			return nil, err
		}
		logger.Info("media storage ready", append(attributes, "driver", "local", "dir", store.Root())...)
		return store, nil

	default:
		return nil, fmt.Errorf("unsupported storage driver %q", driver)
	}
}
