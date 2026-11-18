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
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"

	"github.com/practacu/practacu-press/internal/analytics"
	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/backup"
	"github.com/practacu/practacu-press/internal/captcha"
	"github.com/practacu/practacu-press/internal/community"
	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/extensions"
	"github.com/practacu/practacu-press/internal/infrastructure/analyticsstore"
	"github.com/practacu/practacu-press/internal/infrastructure/auditstore"
	"github.com/practacu/practacu-press/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/internal/infrastructure/communitystore"
	"github.com/practacu/practacu-press/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/infrastructure/mediastore"
	"github.com/practacu/practacu-press/internal/infrastructure/messagingstore"
	"github.com/practacu/practacu-press/internal/infrastructure/moderationstore"
	"github.com/practacu/practacu-press/internal/infrastructure/newsletterstore"
	"github.com/practacu/practacu-press/internal/infrastructure/notificationstore"
	"github.com/practacu/practacu-press/internal/infrastructure/outboxstore"
	"github.com/practacu/practacu-press/internal/infrastructure/platformstore"
	"github.com/practacu/practacu-press/internal/infrastructure/redirectstore"
	"github.com/practacu/practacu-press/internal/infrastructure/safetystore"
	"github.com/practacu/practacu-press/internal/infrastructure/securityclient"
	"github.com/practacu/practacu-press/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/internal/infrastructure/taxonomystore"
	"github.com/practacu/practacu-press/internal/media"
	"github.com/practacu/practacu-press/internal/messaging"
	"github.com/practacu/practacu-press/internal/moderation"
	"github.com/practacu/practacu-press/internal/newsletter"
	"github.com/practacu/practacu-press/internal/notifications"
	"github.com/practacu/practacu-press/internal/observability"
	"github.com/practacu/practacu-press/internal/outbox"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/platform/emailgateway"
	"github.com/practacu/practacu-press/internal/platform/fieldcrypto"
	"github.com/practacu/practacu-press/internal/platform/logging"
	"github.com/practacu/practacu-press/internal/platform/mailer"
	"github.com/practacu/practacu-press/internal/platform/preview"
	"github.com/practacu/practacu-press/internal/platform/sms"
	"github.com/practacu/practacu-press/internal/platformadmin"
	"github.com/practacu/practacu-press/internal/plugins"
	"github.com/practacu/practacu-press/internal/redirect"
	"github.com/practacu/practacu-press/internal/safety"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/system"
	"github.com/practacu/practacu-press/internal/taxonomy"
	ginrouter "github.com/practacu/practacu-press/internal/transport/http/gin"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
	"github.com/practacu/practacu-press/internal/transport/ws"
	"github.com/practacu/practacu-press/internal/web"
)

// Timeouts. There is deliberately no global WriteTimeout: WebSocket connections
// are long lived and a server wide write deadline would sever them. Per request
// deadlines are applied by middleware instead.
const (
	startupTimeout  = 15 * time.Second
	shutdownTimeout = 10 * time.Second
)

// loadDotEnv reads the nearest .env from the working directory up to the module
// root (the directory with go.mod). A missing file is normal (Docker injects
// variables directly); a malformed file is a startup error so a typo cannot
// silently fall back to another environment. Existing process variables always
// win, so `APP_ENV=... go run ./cmd/server` and Compose keep precedence.
func loadDotEnv() (string, error) {
	path := findDotEnv()
	if path == "" {
		return "", nil
	}
	if err := godotenv.Load(path); err != nil {
		return "", fmt.Errorf("load %s: %w", path, err)
	}
	return path, nil
}

func findDotEnv() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		candidate := filepath.Join(dir, ".env")
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return candidate
		}
		// Do not climb past the module root: a stray ~/.env must not configure
		// the server.
		if _, moduleErr := os.Stat(filepath.Join(dir, "go.mod")); moduleErr == nil {
			return ""
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func findModuleRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		if _, moduleErr := os.Stat(filepath.Join(dir, "go.mod")); moduleErr == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func main() {
	if err := run(); err != nil {
		logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
		logger.Error("process exited with error", "error", err)
		os.Exit(1)
	}
}

func run() error {
	// Local runs (GoLand, `go run ./cmd/server`) do not inherit a shell that
	// exported .env. Load it before config validates anything. godotenv does not
	// overwrite variables that are already set, so Docker/Compose and an explicit
	// `APP_ENV=... go run ...` keep precedence.
	dotenvPath, err := loadDotEnv()
	if err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	logger := logging.New(cfg)
	if dotenvPath != "" {
		logger.Info("loaded environment file", "path", dotenvPath)
	}
	frontendWarning := false
	if !web.Available() && cfg.AppEnv == config.EnvDevelopment {
		// `go run` and GoLand compile the binary in place, so the embed directory
		// may only contain .gitkeep. Prefer a built web/dist on disk in development;
		// a release/package build still uses the embedded copy.
		if root := findModuleRoot(); root != "" {
			dir := filepath.Join(root, "web", "dist")
			if dirErr := web.UseDir(dir); dirErr != nil {
				logger.Warn("frontend is not embedded and web/dist is not built; only the API will be served "+
					"(run `npm run build` in web/ or `make embed-web`)", "dir", dir)
				frontendWarning = true
			} else {
				logger.Info("serving frontend from disk (development)", "dir", dir)
			}
		}
	}
	warnUnsetPublicBaseURL(cfg, logger)
	if !web.Available() && !frontendWarning {
		logger.Warn("frontend is not available; only the API will be served")
	}

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

	securityClient := securityclient.NewLocal()
	logger.Info("security checks run in-process", "argon2_concurrency", securityClient.Limits().Concurrency, "argon2_timeout", securityClient.Limits().Timeout)

	// The desktop install starts this process against an empty SQLite file. Making
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

	// The token issuer is built before the services because a second signer is
	// derived from it: the step-up grants use an HMAC key derived from the same
	// Ed25519 seed, so a deployment that configures the signing key gets a stable
	// step-up key and a development install inherits the ephemeral one.
	issuer, ephemeral, err := auth.NewTokenIssuer(cfg)
	if err != nil {
		return fmt.Errorf("build token issuer: %w", err)
	}
	if ephemeral {
		logger.Warn("using an ephemeral JWT signing key: tokens will not survive a restart " +
			"and will not verify on another replica; set AUTH_JWT_ED25519_PRIVATE_KEY")
	}
	stepUpSigner := auth.NewStepUpSigner(issuer, site.StepUpTokenTTL)

	// Personal fields (login addresses, private message bodies) are sealed at rest
	// with a dedicated key. Production requires FIELD_ENCRYPTION_KEY; development
	// keeps a key file next to the data, so a local database survives a restart.
	fieldCipher, err := buildFieldCipher(cfg, logger)
	if err != nil {
		return fmt.Errorf("field encryption: %w", err)
	}

	// Site resolution is always on: without it every request would fall back to a
	// default site, which breaks tenant isolation the moment a second site exists.
	// In production a single site without a domain only answers on a public IP
	// literal; development, tests and the desktop install keep the permissive
	// fallback so localhost still works.
	siteService, err := site.NewService(
		sitestore.New(handle.Client, sitestore.WithFieldCipher(fieldCipher)),
		site.RequirePublicAddress(cfg.AppEnv == config.EnvProduction && !cfg.DesktopMode),
		// The dedicated security password is hashed with the same policy as account
		// passwords; the step-up guard verifies the grants minted by the auth module.
		site.WithStepUpPasswordHasher(choosePasswordHasher(cfg, logger, securityClient)),
		site.WithStepUpTokens(stepUpSigner),
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

	// The content repository is built before media because the media read path asks it
	// whether a content asset is referenced by a published revision. One repository
	// instance serves both dependencies so they cannot drift.
	contentRepo := contentstore.New(handle.Client, handle)

	mediaService, err := media.NewService(media.ServiceConfig{
		Repository: mediastore.New(handle.Client),
		Scanner:    securityScanner{client: securityClient},
		Storage:    mediaStorage,
		Storages:   mediaStorages,
		References: contentRepo,
		Design:     sitestore.NewDesignReferences(handle.Client),
		QuotaDefaults: media.QuotaDefaults{
			UserBytes: cfg.MediaDefaultUserQuotaBytes,
			SiteBytes: cfg.MediaDefaultSiteQuotaBytes,
		},
		QuotaOverrides: mediastore.New(handle.Client),
	})
	if err != nil {
		return fmt.Errorf("build media service: %w", err)
	}

	// The audit store is both the recorder the auth service writes through and the
	// query repository behind the admin activity page. One instance keeps the two
	// sides of the trail on the same schema.
	auditStore := auditstore.New(handle.Client)
	auditService, err := audit.NewService(auditStore)
	if err != nil {
		return fmt.Errorf("build audit service: %w", err)
	}

	// Human verification. The credentials are deployment secrets (environment),
	// while *which* forms are protected is site data read from each site's design
	// document, so an operator can change the policy from the settings page without
	// a redeploy and the server cannot be talked into enforcing a rule it does not
	// have the means to verify. The local provider needs no secret or site key: one
	// in-process store issues and redeems its challenges.
	captchaLocal := captcha.NewLocalStore(captcha.LocalStoreConfig{})
	captchaVerifier := captcha.NewVerifier(captcha.Config{
		Secrets: map[captcha.Provider]string{
			captcha.ProviderTurnstile: cfg.Captcha.TurnstileSecret,
			captcha.ProviderHCaptcha:  cfg.Captcha.HCaptchaSecret,
		},
		Endpoints: map[captcha.Provider]string{
			captcha.ProviderTurnstile: cfg.Captcha.TurnstileURL,
			captcha.ProviderHCaptcha:  cfg.Captcha.HCaptchaURL,
		},
		Local:   captchaLocal,
		Timeout: cfg.Captcha.Timeout,
		Logger:  logger,
	})
	if configured := captchaVerifier.ConfiguredProviders(); len(configured) == 0 {
		logger.Info("human verification has no server secret: sites that enable it are reported as unenforced")
	} else {
		names := make([]string, 0, len(configured))
		for _, provider := range configured {
			names = append(names, string(provider))
		}
		logger.Info("human verification configured", "providers", strings.Join(names, ","))
	}
	captchaGuard := captcha.NewGuard(captcha.GuardConfig{
		Verifier: captchaVerifier,
		// A site that never saved a design document has no captcha section, which
		// reads as "off"; only a real storage failure is an error.
		Customization: func(ctx context.Context, siteID string) ([]byte, error) {
			customization, err := siteService.Customization(ctx, siteID)
			if err != nil {
				if errors.Is(err, site.ErrCustomizationNotFound) {
					return nil, nil
				}
				return nil, err
			}
			return customization.Document, nil
		},
		Audit:  auditStore,
		Logger: logger,
	})
	captchaHandler := captcha.NewHandler(captcha.HandlerConfig{
		Policy: captchaGuard,
		// The same store the verifier redeems against: the challenge endpoint and
		// the protected form must share one process (that is the local provider's
		// deployment boundary).
		Local: captchaLocal,
		SiteID: func(c *gin.Context) string {
			if resolved, ok := middleware.SiteFrom(c); ok {
				return resolved.ID
			}
			return cfg.DefaultSiteID
		},
		RequestID: middleware.RequestIDFrom,
	})

	// Content safety owns the sensitive word list, the site IP rules and the comment
	// frequency windows. One instance is shared by the comment guard, the content
	// guard, the IP guard middleware and the admin endpoints, so an edit takes effect
	// for every enforcement point at once.
	safetyService, err := safety.NewService(
		safetystore.New(handle.Client),
		safety.WithAudit(auditStore),
	)
	if err != nil {
		return fmt.Errorf("build content safety service: %w", err)
	}

	// The SMTP sender is shared by password reset and notification email, so one
	// relay configuration and one optional capability decision reaches both.
	mailSender := buildMailer(cfg, logger)
	// One store backs the mail log for every module: newsletter campaigns, the reset
	// and verification mail from auth, and notification mail all write email_logs
	// through it, which is what makes the dashboard's mail log complete.
	mailLogStore := newsletterstore.New(handle.Client)

	authHandler, authService, err := buildAuth(
		cfg, logger, handle, securityClient, siteService,
		mediaAvatarValidator{media: mediaService},
		auditStore,
		mailSender,
		authMailLog{store: mailLogStore},
		captchaGuard,
		issuer,
		stepUpSigner,
		fieldCipher,
	)
	if err != nil {
		return err
	}

	// Third party login is independent of the password flow and entirely optional:
	// without provider credentials the handler is nil, the router mounts nothing and
	// every other route behaves exactly as before. The state store is shared with
	// the sweeper so expired attempts do not accumulate when the feature is on.
	oauthStates := authstore.NewOAuthStateStore(handle)
	oauthHandler := buildOAuth(cfg, logger, handle, authService, fieldCipher, oauthStates)
	if oauthHandler != nil {
		go runOAuthStateSweeper(ctx, logger, oauthStates)
	}

	// The platform console owns deployment level site lifecycle. It borrows auth for
	// password hashing and session minting, and the site store for the site rows, so
	// creating a site and entering it use exactly the same rules as everything else.
	platformService, err := platformadmin.NewService(platformadmin.ServiceConfig{
		Repository: sitestore.New(handle.Client, sitestore.WithFieldCipher(fieldCipher)),
		Accounts:   authService,
		Sessions:   authService,
		Tokens:     issuer,
		// The console is the bootstrap path for a new site: its hostname only resolves
		// after the DNS challenge succeeds, and the site's own admin UI is unreachable
		// until then.
		Domains: siteService,
		// The cross-site views read across tenants, so they borrow the shared audit
		// store (both its cross-site reader and its recorder) and one adapter that
		// counts sites, members, content, comments, reports and accounts in one pass.
		Metrics:   platformstore.New(handle.Client, platformstore.WithFieldCipher(fieldCipher)),
		Directory: platformstore.New(handle.Client, platformstore.WithFieldCipher(fieldCipher)),
		Trail:     auditStore,
		Recorder:  auditStore,
	})
	if err != nil {
		return fmt.Errorf("build platform service: %w", err)
	}

	hub := ws.NewHub()
	tickets := ws.NewTicketStore(nil)

	notificationService, err := notifications.NewService(
		notificationstore.New(handle.Client, notificationstore.WithFieldCipher(fieldCipher)),
		// The inbox row is committed first; the live push wakes the bell without a
		// poll. Delivery is best effort because GET /notifications is authoritative.
		notifications.WithPublisher(liveNotificationPublisher{hub: hub}),
		// Comment, reaction, follow and review notifications also honour the
		// recipient's channel switches and optionally go out as email.
		notifications.WithMailer(mailSender),
		notifications.WithMailLog(notificationMailLog{store: mailLogStore}),
		notifications.WithBaseURL(cfg.PublicBaseURL),
		notifications.WithLogger(logger),
	)
	if err != nil {
		return fmt.Errorf("build notification service: %w", err)
	}

	communityStore := communitystore.New(handle.Client)
	communityService, err := community.NewService(communityStore, communityStore,
		// Resolve the target before writing an interaction (V-15) and require an active
		// membership for follows. Both checks are optional in the package; the server
		// always wires them.
		community.WithTargetChecker(communityStore),
		community.WithMembershipChecker(siteMembershipChecker{sites: siteService}),
		// The site level comment switches are enforced server side, so a direct API
		// call cannot post to a closed thread or bypass review mode.
		community.WithCommentPolicy(siteService),
		// Sensitive words and the per-user / per-IP comment windows run inside the
		// service, before anything is written.
		community.WithCommentGuard(safetyService),
		// Comments, replies, likes, follows and review decisions also land in the
		// recipient's inbox; the outbox rows above only feed live pushes.
		community.WithNotifier(communityNotifier{
			notifications: notificationService,
			logger:        logger,
		}),
	)
	if err != nil {
		return fmt.Errorf("build community service: %w", err)
	}

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

	messageService, err := messaging.NewService(
		messagingstore.New(handle.Client, messagingstore.WithFieldCipher(fieldCipher)),
		// Only active members of the site may be put into a conversation (V-14).
		messaging.WithMembershipChecker(siteMembershipChecker{sites: siteService}),
		// Beta 1.2: a delivered message also lands in each recipient's inbox. The fan
		// out is best effort on purpose: the message row is the authoritative record,
		// and an inbox write failing must not turn a successful send into an error.
		messaging.WithNotifier(notificationService),
		messaging.WithLogger(logger),
	)
	if err != nil {
		return fmt.Errorf("build messaging service: %w", err)
	}

	// The public contact form reuses that pipeline instead of adding a table: one inbox
	// row per active site administrator, and the reader's message is stored nowhere else.
	// The 60 second floor is in-process, so a multi-instance deployment relies on the
	// engine's rate limiter for the fleet-wide bound (see internal/site/contact.go).
	contactService, err := site.NewContactService(site.ContactConfig{
		Repository: sitestore.New(handle.Client, sitestore.WithFieldCipher(fieldCipher)),
		Notifier:   notificationService,
	})
	if err != nil {
		return fmt.Errorf("build contact service: %w", err)
	}

	// Redirect rules are the other half of the permalink change: the content service
	// records an automatic 301 when a published slug moves, and the public resolver
	// answers the page server. The two services reference each other, so the mutual
	// edges are wired after both exist.
	redirectService, err := redirect.NewService(redirect.ServiceConfig{
		Repository: redirectstore.New(handle.Client),
	})
	if err != nil {
		return fmt.Errorf("build redirect service: %w", err)
	}

	contentService, err := content.NewService(content.ServiceConfig{
		Repository: contentRepo,
		// The same repository enforces the per-author draft quota (V-06): a free
		// account cannot grow the database without bound by creating drafts.
		DraftQuota: contentRepo,
		Sanitizer:  securitySanitizer{client: securityClient},
		// The same word list that filters comments also filters article and post
		// submissions; content never publishes around the policy.
		ContentGuard: safetyService,
		PublishMode: func(ctx context.Context, siteID string) (site.PublishMode, error) {
			return siteService.PublishMode(ctx, siteID)
		},
		// Password protected items reuse the authentication module's password
		// hashing policy; only the hash is stored on the content row (C-18).
		AccessPasswordHasher: choosePasswordHasher(cfg, logger, securityClient),
		// The unlock grant is signed by the same issuer as an access token, but with
		// its own purpose claim, so it can only be replayed for one item.
		UnlockTokens: issuer,
		// Publish/reject decisions land in the author's inbox.
		ReviewNotifier: contentReviewNotifier{notifications: notificationService},
		// Beta 1.2: when a published slug changes the old path keeps working.
		RedirectRecorder: redirectService,
	})
	if err != nil {
		return fmt.Errorf("build content service: %w", err)
	}

	// The resolver needs a content lookup and the content service needs a rule
	// writer; wiring the second edge here keeps both constructors independent.
	redirectService.SetLocator(contentService)

	// Draft preview links are signed with a key that lives in the data directory, so
	// a restart keeps already handed out links usable and a copied database cannot
	// mint its own.
	previewSigner, err := preview.Open(extensionDataDir(cfg))
	if err != nil {
		return fmt.Errorf("open preview signer: %w", err)
	}
	contentService.SetPreviewSigner(previewSigner)
	// The scheduled publisher is the in-process half of C-17: a due draft is
	// promoted every 10 seconds. The transition is conditional, so a second replica
	// simply loses the race instead of publishing twice.
	go runContentScheduler(ctx, logger, contentService)

	// Newsletter: subscriptions, templates, the mail log and the campaign sender. The
	// gateway writes one email_logs row per attempt, which is what makes "mail is
	// configured" verifiable from the dashboard instead of only in the relay log.
	// The newsletter reuses the same store: one email_logs table backs campaigns and
	// system mail alike, so the operator sees one timeline instead of two.
	newsletterRepo := mailLogStore
	emailGateway := emailgateway.New(newsletterRepo, mailSender, emailgateway.WithLogger(logger))
	newsletterService, err := newsletter.NewService(newsletter.ServiceConfig{
		Repository:    newsletterRepo,
		Gateway:       emailGateway,
		PublicBaseURL: cfg.PublicBaseURL,
		AccountEmail: func(ctx context.Context, userID string) (string, error) {
			view, err := authService.Me(ctx, userID)
			if err != nil {
				return "", err
			}
			return view.Email, nil
		},
		// The content service already renders title, summary and the canonical link.
		ContentDigest: contentService,
		Logger:        logger,
	})
	if err != nil {
		return fmt.Errorf("build newsletter service: %w", err)
	}
	newsletterSender := newsletter.NewSender(newsletterService, newsletter.SenderConfig{Logger: logger})
	go newsletterSender.Start(ctx)
	newsletterHandler := newsletter.NewHandler(newsletterService, newsletter.HandlerConfig{
		Principal: func(c *gin.Context) (newsletter.Principal, bool) {
			principal, ok := middleware.PrincipalFrom(c)
			if !ok {
				return newsletter.Principal{}, false
			}
			out := newsletter.Principal{
				UserID: principal.UserID,
				SiteID: principal.SiteID,
				Role:   principal.Role,
			}
			if member, ok := middleware.MembershipFrom(c); ok {
				out.CanManageSite = member.Allows(site.CapabilityManageSite)
			}
			return out, true
		},
		Site:          middleware.SiteFrom,
		PublicBaseURL: cfg.PublicBaseURL,
		Secure:        cfg.CookieSecure,
	})

	// The report queue composes the content, community and site services through
	// narrow ports: a moderation decision uses each module's own state machine
	// instead of writing a parallel status behind its back.
	moderationStore := moderationstore.New(handle.Client)
	moderationService, err := moderation.NewService(
		moderationStore,
		moderation.WithTargetResolver(moderationStore),
		moderation.WithTargetModerator(moderationTargets{
			content:   contentService,
			community: communityService,
			sites:     siteService,
		}),
		moderation.WithNotifier(moderationNotifier{notifications: notificationService}),
	)
	if err != nil {
		return fmt.Errorf("build moderation service: %w", err)
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

	// Backups are deployment data, so the package is built even when the active
	// driver cannot snapshot in-process: the HTTP endpoint and CLI answer with the
	// native dump tool limitation instead of pretending a package exists.
	backupKey, err := buildBackupKey(cfg)
	if err != nil {
		return fmt.Errorf("backup encryption: %w", err)
	}
	backupService, err := backup.NewService(backup.Config{
		Driver:        cfg.DatabaseDriver,
		DSN:           cfg.DatabaseDSN,
		EncryptionKey: backupKey,
		Snapshotter:   handle,
		MediaRoots:    backupMediaRoots(cfg),
		Designs:       backup.NewDBDesignSource(handle),
		BackupDir:     cfg.BackupDir,
		SchemaVersion: db.SchemaVersion,
		AppVersion:    backup.BuildVersion(),
		Sites:         siteService,
		Content:       contentService,
		Taxonomy:      taxonomyService,
		Media:         mediaService,
	})
	if err != nil {
		return fmt.Errorf("build backup service: %w", err)
	}

	// Seal rows written before field encryption existed. This runs after the schema
	// is usable and before the API serves its first request, so a read never has to
	// guess whether a value is an envelope or legacy plaintext.
	runFieldBackfills(startupCtx, handle, fieldCipher, logger)

	// The resource panel is an optional deployment level module: it samples host and
	// process metrics in the background and serves them to platform administrators.
	// PP_SYSTEM_METRICS=off removes the route entirely, which is how a deployment that
	// does not want to expose host details disables the panel.
	systemHandler := buildSystemHandler(ctx, cfg, logger)

	// Extensions are installed packages that may carry a browser half and a WASM
	// backend. The host is the sandbox; the manager owns the package directory and the
	// persisted enable/disable decisions, so a restart restores the same catalogue.
	// The host version is left empty on purpose: package engines.pp ranges are checked
	// when a release exposes a stable host version.
	pluginHost, err := plugins.New(plugins.Options{Logger: logger})
	if err != nil {
		return fmt.Errorf("build plugin host: %w", err)
	}
	extensionManager, err := extensions.NewManager(extensions.Options{
		Host:    pluginHost,
		DataDir: extensionDataDir(cfg),
		Logger:  logger,
		// Integrity failures found while loading packages at boot are recorded here.
		Audit: auditStore,
	})
	if err != nil {
		_ = pluginHost.Close()
		return fmt.Errorf("build extension manager: %w", err)
	}
	defer func() {
		if closeErr := extensionManager.Close(); closeErr != nil {
			logger.Error("close extension manager", "error", closeErr)
		}
	}()

	// Operator console backends: a bounded request log ring buffer, the queue viewer
	// and the automatic backup loop. All three are read only views over data the
	// process already owns, so they live here rather than in their own services.
	requestLog := observability.NewRecorder()
	systemOps := system.NewOpsHandler(
		requestLog,
		system.NewEntQueueStore(handle.Client),
		system.OpsHandlerConfig{},
	)
	scheduleOpts, err := backup.EnvSchedulerOptions()
	if err != nil {
		// A malformed BACKUP_AUTO_* value fails the boot instead of scheduling the
		// wrong thing silently, the same rule storage and mail variables follow.
		return fmt.Errorf("backup schedule: %w", err)
	}
	scheduleOpts.Logger = logger
	scheduleOpts.Audit = auditStore
	backupScheduler, err := backup.NewScheduler(backupService, scheduleOpts)
	if err != nil {
		return fmt.Errorf("build backup scheduler: %w", err)
	}
	go backupScheduler.Start(ctx)
	backupScheduleHandler := backup.NewScheduleHandler(backupScheduler, backup.ScheduleHandlerConfig{})

	router := ginrouter.New(ginrouter.Dependencies{
		Config:       cfg,
		Logger:       logger,
		Readiness:    handle.Ping,
		SiteResolver: siteService,
		// Beta 1.2: request metadata for the operator console. Bodies, headers,
		// cookies and query strings never enter the buffer.
		RequestLog: requestLog,
		// Queue statistics and the manual retry action.
		Ops: systemOps,
		// The auto backup schedule the process is actually running with.
		BackupSchedule: backupScheduleHandler,
		// Public path resolution for the page server plus the site level redirect
		// rules the permalink change depends on.
		Redirect: redirect.NewHandler(redirectService, redirect.HandlerConfig{
			Principal: func(c *gin.Context) (site.Member, bool) {
				if member, ok := middleware.MembershipFrom(c); ok {
					return member, true
				}
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return site.Member{}, false
				}
				return site.Member{
					UserID: principal.UserID,
					SiteID: principal.SiteID,
					Role:   principal.Role,
					Status: site.MemberStatusActive,
				}, true
			},
			Site: middleware.SiteFrom,
		}),
		// Subscriptions, templates, the mail log and campaign sending.
		Newsletter: newsletterHandler,
		// Beta 1.2: applies the per-site origin list the dashboard already collected.
		// The site service owns the document, so the transport asks it rather than
		// parsing site configuration a second time.
		SiteCORSOrigins: siteService.SiteCORSOrigins,
		Install:         siteService,
		// Extension administration is deployment scoped, so the handler re-checks the
		// platform administrator seat itself; the payload can install server side code.
		Extensions: extensions.NewHandler(extensionManager, extensions.HandlerConfig{
			Principal: func(c *gin.Context) (string, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return "", false
				}
				return string(principal.Role), true
			},
		}),
		// The plugin host serves the boot manifest, the namespaced plugin API and the
		// browser bundles. It is wired through the manager so install/remove from the
		// console and this runtime share one registry.
		Plugins: extensionManager.Host(),
		// The IP allow and deny lists are evaluated after the host selects the site.
		IPPolicy:     safetyService,
		AccessTokens: issuer,
		// The guard re-reads the live membership, so a demoted, suspended or removed
		// account loses its authority immediately instead of when its token expires.
		Memberships: siteService,
		// High threat operations additionally require a fresh password proof when the
		// site enables it; the enforcer reads the setting and verifies the grant.
		StepUp: ginrouter.StepUpDependencies{Enforcer: siteService},
		// Optional deployment level resource panel; nil when PP_SYSTEM_METRICS=off.
		System: systemHandler,
		Auth:   authHandler,
		// Third party login is mounted only when a provider is configured; nil leaves
		// the routes absent and the rest of the API untouched.
		OAuth: oauthHandler,
		// Public status for the login, registration, password reset and comment
		// forms, plus the admin settings page.
		Captcha: captchaHandler,
		Audit: audit.NewHandler(auditService, audit.HandlerConfig{
			Principal: func(c *gin.Context) (site.Member, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return site.Member{}, false
				}
				return site.Member{
					UserID: principal.UserID,
					SiteID: principal.SiteID,
					Role:   principal.Role,
					Status: site.MemberStatusActive,
				}, true
			},
		}),
		Platform: platformadmin.NewHandler(platformService, platformadmin.HandlerConfig{
			Principal: func(c *gin.Context) (string, string, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				return principal.UserID, principal.SiteID, ok
			},
			Site: middleware.SiteFrom,
			// Redeeming a handoff token produces the same cookies and body as a login.
			Sessions: authHandler,
		}),
		Sites: site.NewHandler(siteService, site.HandlerConfig{
			Principal: func(c *gin.Context) (string, string, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				return principal.UserID, principal.SiteID, ok
			},
			Site: func(c *gin.Context) (site.Site, bool) {
				return middleware.SiteFrom(c)
			},
			RequestID: middleware.RequestIDFrom,
			Contact:   contactService,
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
				return media.Actor{UserID: principal.UserID, SiteID: principal.SiteID, Role: principal.Role}, true
			},
			// Anonymous downloads are scoped by the resolved host; uploads never are.
			Site: func(c *gin.Context) (site.Site, bool) { return middleware.SiteFrom(c) },
		}),
		Reports: moderation.NewHandler(moderationService, moderation.HandlerConfig{
			Principal: func(c *gin.Context) (moderation.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return moderation.Actor{}, false
				}
				return moderation.Actor{
					UserID: principal.UserID,
					SiteID: principal.SiteID,
					Role:   principal.Role,
				}, true
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
					// The frequency limits count signed-in writes by IP as well as by
					// account, so the resolved client address joins the actor.
					IP: c.ClientIP(),
				}, true
			},
			Site: func(c *gin.Context) (site.Site, bool) { return middleware.SiteFrom(c) },
			// Comments are the highest-volume text surface, so that is the write the
			// site can put a challenge in front of.
			Captcha:   captchaGuard,
			RequestID: middleware.RequestIDFrom,
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
			// The unlock grant cookie follows the same transport policy as the
			// session cookies.
			CookieSecure: cfg.CookieSecure,
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
		Safety: safety.NewHandler(safetyService, safety.HandlerConfig{
			Principal: func(c *gin.Context) (safety.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return safety.Actor{}, false
				}
				return safety.Actor{
					UserID: principal.UserID,
					SiteID: principal.SiteID,
					Role:   principal.Role,
				}, true
			},
		}),
		// Backup packages contain the deployment database, so creation, listing and
		// download are platform administrator only; export and import are scoped to
		// the caller's own site.
		Backups: backup.NewHandler(backupService, backup.HandlerConfig{
			Principal: func(c *gin.Context) (backup.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return backup.Actor{}, false
				}
				return backup.Actor{
					UserID: principal.UserID,
					SiteID: principal.SiteID,
					Role:   principal.Role,
				}, true
			},
		}),
		// The host-resolved site supplies both the crawler view: the content service
		// lists published items through the anonymous actor, and the site service
		// provides the SEO switch and custom pages stored in the design document.
		SiteFiles: ginrouter.SiteFilesDependencies{
			Customization: siteService,
			Content:       contentService,
		},
		// Feeds read the same design document for their on/off switch, entry count and
		// full-text setting. Taxonomy resolves category and tag slugs; the site service
		// supplies the public author name each entry may carry.
		Feed: ginrouter.FeedDependencies{
			Customization: siteService,
			Content:       contentService,
			Taxonomy:      taxonomyService,
			Authors:       siteService,
		},
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

// warnUnsetPublicBaseURL explains which origin absolute links fall back to.
//
// PUBLIC_BASE_URL is optional because a same origin deployment can derive the
// browser origin from the request. Two things still need a configured origin:
// third party login callbacks, which are derived from each site's domain, and mail
// links rendered outside a request. Without the variable the server assumes https,
// which is right behind a TLS proxy and wrong for a desktop or localhost install
// served over plain http, so the operator has to hear it at startup instead of
// discovering it through a broken link.
func warnUnsetPublicBaseURL(cfg config.Config, logger *slog.Logger) {
	if strings.TrimSpace(cfg.PublicBaseURL) != "" {
		return
	}
	if cfg.DesktopMode {
		logger.Warn("PUBLIC_BASE_URL is not set: this desktop install is served over http, " +
			"but third party login callbacks and mail links assume https; " +
			"set PUBLIC_BASE_URL=http://127.0.0.1:<port> when you use them")
		return
	}
	logger.Warn("PUBLIC_BASE_URL is not set: third party login callbacks and links rendered " +
		"outside a request assume https; set it explicitly for an http deployment, " +
		"for example PUBLIC_BASE_URL=http://127.0.0.1:<port> on localhost")
}

// extensionDataDir is the data root extension packages are persisted under.
//
// The data root is the parent of the configured media storage directory, which is
// where the database, backups and logs already live; a deployment that has no
// storage configuration falls back to the documented ./data default.
func extensionDataDir(cfg config.Config) string {
	if strings.TrimSpace(cfg.StorageDir) == "" {
		return "./data"
	}
	return filepath.Dir(cfg.StorageDir)
}

// requestSiteID resolves the site a request belongs to for the auth handler.
//
// Host resolution is authoritative. The configured default is the single site
// fallback the desktop bootstrap and development setups rely on; production with
// several sites never has one. This is the same rule the captcha handler uses.
func requestSiteID(cfg config.Config) auth.SiteIDFunc {
	return func(c *gin.Context) string {
		if resolved, ok := middleware.SiteFrom(c); ok {
			return resolved.ID
		}
		return cfg.DefaultSiteID
	}
}

// buildAuth wires the authentication module.
//
// The token issuer and the step-up signer originate in run() because the site
// service needs the step-up signer too: the guard that protects high threat routes
// verifies the same grants this module mints.
func buildAuth(cfg config.Config, logger *slog.Logger, handle *db.DB, security securityclient.Client, sites *site.Service, avatars auth.AvatarValidator, auditRecorder audit.Recorder, mailSender mailer.Sender, mailLog auth.MailLog, captchaGuard auth.CaptchaGuard, issuer *auth.TokenIssuer, stepUpSigner *auth.StepUpSigner, fieldCipher *fieldcrypto.Cipher) (*auth.Handler, *auth.Service, error) {
	// The phone sign-in gateway. A deployment with SMS_PROVIDER=off gets a nil sender
	// and the phone endpoints report themselves unavailable instead of failing later.
	smsSender, err := sms.New(sms.Config{
		Provider: cfg.SMSProvider,
		URL:      cfg.SMSHTTPURL,
		Token:    cfg.SMSHTTPToken,
		Logger:   logger,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("build sms sender: %w", err)
	}
	service, err := auth.NewService(auth.ServiceConfig{
		Repository: authstore.New(handle.Client, authstore.WithFieldCipher(fieldCipher)),
		Hasher:     choosePasswordHasher(cfg, logger, security),
		Tokens:     issuer,
		// A desktop install has no operator console to promote its first account,
		// so registration does it once. Every other deployment keeps plain members.
		BootstrapFirstAdmin: cfg.DesktopMode,
		// Self-service registration follows the site setting (O-3): an operator can
		// close sign-ups without redeploying, and the desktop wizard still creates the
		// first administrator into a fresh (default-open) site.
		RegistrationPolicy: sites.RegistrationOpen,
		Mailer:             mailSender,
		// Every system mail also lands in email_logs, so the dashboard can answer
		// "did the reset mail go out" without reading the relay's log.
		MailLog:         mailLog,
		PublicBaseURL:   cfg.PublicBaseURL,
		Audit:           auditRecorder,
		AvatarValidator: avatars,
		// High threat operations re-prove a password; the minted grant is verified
		// by the step-up guard from the same signer instance.
		StepUpSigner: stepUpSigner,
		StepUpConfig: sites,
		Logger:       logger,
		// Beta 1.2: phone sign-in. The SMS sender may be nil, which is the ordinary
		// state of a deployment that never configured a gateway.
		SMS:         smsSender,
		SMSProvider: cfg.SMSProvider,
		SMSDevMode:  cfg.SMSDevMode,
		SMSCodeTTL:  cfg.SMSCodeTTL,
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
		SiteID:            requestSiteID(cfg),
		Principal:         middleware.PrincipalFrom,
		// The desktop bootstrap lets the first account become platform administrator.
		// Only a loopback caller may claim that seat, so a not yet installed instance
		// exposed over the network cannot be taken over before the operator arrives.
		// The Docker single-host profile opts into the local-proxy variant because
		// port publishing hides the client address; see the flag's config comment.
		FirstAdminAllowed: chooseFirstAdminRule(cfg, logger),
		// Registration, password login and password reset are the credential entry
		// points; each runs the site's human verification policy before hashing.
		Captcha:   captchaGuard,
		RequestID: middleware.RequestIDFrom,
		// The dashboard needs the caller's capability group, not only the role:
		// a custom group narrows what the base role may show.
		GroupKey: func(ctx context.Context, siteID, userID string) (string, error) {
			member, err := sites.Membership(ctx, siteID, userID)
			if err != nil {
				return "", err
			}
			return member.GroupKey, nil
		},
	})

	return handler, service, nil
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

// chooseFirstAdminRule picks how strictly the install's first administrator may be
// claimed.
//
// The strict rule needs a loopback client address, which a Docker published port
// hides (the API sees the bridge gateway). The opt-in variant only checks the Host
// header, so it is limited to the desktop bootstrap and warned about loudly.
func chooseFirstAdminRule(cfg config.Config, logger *slog.Logger) auth.FirstAdminFunc {
	if cfg.FirstAdminTrustProxy {
		logger.Warn("first administrator may be claimed through the local reverse proxy: " +
			"keep the published port bound to 127.0.0.1 until the install is complete")
		return auth.AllowFirstAdminFromLocalProxy
	}
	return auth.AllowFirstAdminFromLoopback
}

// buildMailer returns the SMTP sender, or nil when no relay is configured.
//
// Nil is meaningful rather than lazy: both password reset and notification email
// report themselves as unavailable instead of accepting work they cannot deliver.
func buildMailer(cfg config.Config, logger *slog.Logger) mailer.Sender {
	if cfg.SMTPHost == "" {
		logger.Info("SMTP is not configured: password reset and notification email are disabled")
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

// mediaAvatarValidator adapts media.Service to auth.AvatarValidator.
//
// The auth module must not import the media module, so the composition root owns
// this narrow bridge. An asset that is missing, rejected, of another purpose or
// owned by someone else is reported as an invalid avatar; any other storage error
// propagates unchanged.
type mediaAvatarValidator struct {
	media *media.Service
}

// ValidateAvatar implements auth.AvatarValidator.
func (v mediaAvatarValidator) ValidateAvatar(
	ctx context.Context,
	siteID, userID, assetID string,
) error {
	if v.media == nil {
		return auth.ErrAvatarInvalid
	}
	err := v.media.ValidateAvatar(ctx, media.Actor{
		UserID: userID,
		SiteID: siteID,
		Role:   site.RoleMember,
	}, assetID)
	if err != nil {
		if errors.Is(err, media.ErrNotFound) {
			return auth.ErrAvatarInvalid
		}
		return err
	}
	return nil
}

// securitySanitizer adapts the security client to the content module's
// narrow Sanitizer port.
//
// The adapter lives at the composition root so neither package has to import the
// other's infrastructure.
type securitySanitizer struct {
	client securityclient.Client
}

// Sanitize delegates sanitization to the security package.
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

// choosePasswordHasher uses the in-process Go security implementation. It never
// silently falls back to a weaker algorithm: the same Argon2id policy serves
// development, tests and production.
func choosePasswordHasher(_ config.Config, logger *slog.Logger, security securityclient.Client) auth.PasswordHasher {
	logger.Info("password hashing uses the in-process Go security package")
	return auth.NewSecurityPasswordHasher(security)
}

func buildSystemHandler(
	ctx context.Context,
	cfg config.Config,
	logger *slog.Logger,
) *system.Handler {
	if systemMetricsDisabled() {
		logger.Info("system metrics panel disabled by PP_SYSTEM_METRICS")
		// The effective deployment configuration is not part of the resource panel: an
		// operator reads it exactly when they are debugging storage or access settings,
		// which is also when they may have switched the panel off. It survives that
		// switch, mounted without a sampler.
		return system.NewHandler(nil, system.HandlerConfig{
			Principal: func(c *gin.Context) (string, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return "", false
				}
				return string(principal.Role), true
			},
			Deployment: func() config.Config { return cfg },
		})
	}
	appDirs := make([]string, 0, 3)
	if workingDir, err := os.Getwd(); err == nil {
		appDirs = append(appDirs, workingDir)
	}
	if executable, err := os.Executable(); err == nil {
		appDirs = append(appDirs, filepath.Dir(executable))
	}
	dataDir := filepath.Dir(cfg.StorageDir)
	if cfg.StorageDir == "" {
		dataDir = ""
	}
	sampler := system.NewSampler(system.SamplerConfig{
		AppNames:  system.DefaultAppNames(),
		AppDirs:   appDirs,
		DataDir:   dataDir,
		MediaDir:  cfg.StorageDir,
		BackupDir: cfg.BackupDir,
	})
	sampler.Start(ctx)
	logger.Info("system metrics panel enabled", "data_dir", dataDir)

	return system.NewHandler(sampler.Latest, system.HandlerConfig{
		Principal: func(c *gin.Context) (string, bool) {
			principal, ok := middleware.PrincipalFrom(c)
			if !ok {
				return "", false
			}
			return string(principal.Role), true
		},
		// Beta 1.2: the storage and access panels report the values this process really
		// loaded, so a site owner can tell a saved setting from an applied one.
		Deployment: func() config.Config { return cfg },
	})
}

// systemMetricsDisabled reports whether the operator turned the resource panel off.
func systemMetricsDisabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("PP_SYSTEM_METRICS"))) {
	case "off", "0", "false", "no", "disabled":
		return true
	default:
		return false
	}
}

// securityScanner adapts the security client to the media module's Scanner port.
type securityScanner struct {
	client securityclient.Client
}

// Inspect delegates upload inspection to the security package.
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

// siteMembershipChecker adapts the site service to the authorization ports of the
// community and messaging services.
//
// Both packages accept a narrow IsActiveMember check instead of importing the site
// aggregate. A suspended or removed membership is reported as "not active"; any other
// failure propagates so the caller fails closed instead of silently skipping the check.
type siteMembershipChecker struct {
	sites *site.Service
}

// IsActiveMember implements community.UserMembershipChecker and
// messaging.MembershipChecker.
func (c siteMembershipChecker) IsActiveMember(ctx context.Context, siteID, userID string) (bool, error) {
	if _, err := c.sites.Membership(ctx, siteID, userID); err != nil {
		if errors.Is(err, site.ErrMemberNotFound) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// moderationTargets adapts the content, community and site services to the report
// queue's target action port.
//
// A moderation decision therefore runs the owning module's state machine: content is
// archived, a comment is hidden, and an account is suspended through member
// administration, each with its own audit entry.
type moderationTargets struct {
	content   *content.Service
	community *community.Service
	sites     *site.Service
}

// Takedown removes the reported target from public view.
func (m moderationTargets) Takedown(
	ctx context.Context,
	actor moderation.Actor,
	targetType moderation.TargetType,
	targetID string,
) error {
	switch targetType {
	case moderation.TargetArticle, moderation.TargetPost:
		contentActor := content.Actor{UserID: actor.UserID, SiteID: actor.SiteID, Role: actor.Role}
		item, err := m.content.Get(ctx, contentActor, targetID)
		if err != nil {
			if errors.Is(err, content.ErrNotFound) {
				return moderation.ErrTargetNotFound
			}
			return err
		}
		// Anything not published is already out of public view; a takedown of a draft
		// is a no-op rather than an invalid transition.
		if item.Status != content.StatusPublished {
			return nil
		}
		if _, err := m.content.Apply(ctx, contentActor, targetID, content.ActionArchive, "moderation report"); err != nil {
			if errors.Is(err, content.ErrInvalidTransition) {
				return moderation.ErrActionNotAllowed
			}
			return err
		}
		return nil
	case moderation.TargetComment:
		communityActor := community.Actor{UserID: actor.UserID, SiteID: actor.SiteID, Role: actor.Role}
		if _, err := m.community.ModerateComment(ctx, communityActor, targetID, community.CommentStatusHidden); err != nil {
			if errors.Is(err, community.ErrNotFound) {
				return moderation.ErrTargetNotFound
			}
			return err
		}
		return nil
	default:
		return moderation.ErrActionNotAllowed
	}
}

// Ban suspends the reported account through the site member administration rules.
func (m moderationTargets) Ban(ctx context.Context, actor moderation.Actor, userID string) error {
	memberActor := site.Member{
		UserID: actor.UserID,
		SiteID: actor.SiteID,
		Role:   actor.Role,
		Status: site.MemberStatusActive,
	}
	if _, err := m.sites.UpdateMemberStatus(
		ctx, memberActor, actor.SiteID, userID, site.MemberStatusSuspended, "",
	); err != nil {
		switch {
		case errors.Is(err, site.ErrTargetNotFound), errors.Is(err, site.ErrMemberNotFound):
			return moderation.ErrTargetNotFound
		case errors.Is(err, site.ErrPermissionDenied), errors.Is(err, site.ErrTargetTooPrivileged),
			errors.Is(err, site.ErrCannotManageSelf):
			return moderation.ErrActionNotAllowed
		default:
			return err
		}
	}
	return nil
}

// communityNotifier adapts notifications.Service to the community module's
// notification port: a comment, reply, like, follow or review decision becomes one
// inbox row with the recipient's preferences applied.
type communityNotifier struct {
	notifications *notifications.Service
	logger        *slog.Logger
}

// NotifyInteraction implements community.Notifier.
func (n communityNotifier) NotifyInteraction(ctx context.Context, in community.Notification) error {
	_, err := n.notifications.Notify(ctx, notifications.NewInput{
		SiteID:    in.SiteID,
		UserID:    in.UserID,
		Type:      notifications.Type(in.Type),
		ActorID:   in.ActorID,
		SubjectID: in.SubjectID,
		DedupeKey: in.DedupeKey,
		Payload:   in.Payload,
	})
	if err != nil && n.logger != nil {
		// The interaction already committed; the producer cannot undo it, so this
		// is the operator's only trace that an inbox row was lost.
		n.logger.Error("write community notification failed",
			"error", err, "notification_type", in.Type, "user_id", in.UserID)
	}
	return err
}

// moderationNotifier adapts notifications.Service to the report queue's notifier.
type moderationNotifier struct {
	notifications *notifications.Service
} // NotifyModeration writes one moderation.updated inbox row.
func (n moderationNotifier) NotifyModeration(ctx context.Context, in moderation.ModerationNotification) error {
	_, err := n.notifications.Notify(ctx, notifications.NewInput{
		SiteID:    in.SiteID,
		UserID:    in.UserID,
		Type:      notifications.TypeModeration,
		ActorID:   in.ActorID,
		SubjectID: in.ReportID,
		Payload: map[string]string{
			"report_id":   in.ReportID,
			"target_type": string(in.TargetType),
			"target_id":   in.TargetID,
			"action":      string(in.Action),
			"status":      string(in.Status),
			"note":        truncatePayload(in.Note, notifications.MaxPayloadValueLength),
			"excerpt":     truncatePayload(in.Note, notifications.MaxPayloadValueLength),
		},
	})
	return err
}

// contentReviewNotifier adapts notifications.Service to the content module's review
// notification port.
type contentReviewNotifier struct {
	notifications *notifications.Service
}

// NotifyReview tells an author that their submission was published or rejected.
func (n contentReviewNotifier) NotifyReview(ctx context.Context, in content.ReviewNotification) error {
	decision := string(in.Status)
	_, err := n.notifications.Notify(ctx, notifications.NewInput{
		SiteID:    in.SiteID,
		UserID:    in.UserID,
		Type:      notifications.TypeModeration,
		ActorID:   in.ActorID,
		SubjectID: in.ContentID,
		Payload: map[string]string{
			"kind":        in.Kind,
			"content_id":  in.ContentID,
			"target_type": in.Kind,
			"target_id":   in.ContentID,
			"title":       truncatePayload(in.Title, notifications.MaxPayloadValueLength),
			"status":      string(in.Status),
			"decision":    decision,
			"excerpt":     truncatePayload(in.Reason, notifications.MaxPayloadValueLength),
			"reason":      truncatePayload(in.Reason, notifications.MaxPayloadValueLength),
		},
	})
	return err
}

// truncatePayload bounds a free text value for a notification payload.
//
// The bound is in bytes because that is what the notification validator enforces;
// cutting only at a rune boundary keeps the result valid UTF-8.
func truncatePayload(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := value[:limit]
	for len(cut) > 0 {
		if utf8.ValidString(cut) {
			return cut
		}
		cut = cut[:len(cut)-1]
	}
	return ""
}

// liveNotificationPublisher adapts notifications.Service to the WebSocket hub.
//
// It lives at the composition root so the notifications package keeps describing
// what happened without importing the transport.
type liveNotificationPublisher struct {
	hub *ws.Hub
}

// Publish implements notifications.Publisher.
//
// Delivery runs off the request path: a live socket that stops reading must not add
// its write deadline to the response that created the notification. The outbox worker
// already treats live delivery as best effort for the same reason.
func (p liveNotificationPublisher) Publish(ctx context.Context, event notifications.LiveEvent) {
	go p.hub.Publish(context.WithoutCancel(ctx), ws.Event{
		// No event id: this push is not in the outbox, so it must not advance the
		// client's replay cursor (see notifications.LiveEvent).
		Type:           event.Type,
		OccurredAt:     event.OccurredAt,
		SiteID:         event.SiteID,
		AudienceUserID: event.AudienceUserID,
		Payload:        event.Payload,
	})
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

// contentSchedulerInterval is how often due schedules are checked. The product
// promises minute precision, so a ten second tick keeps the observable delay small
// without adding a second job queue.
const contentSchedulerInterval = 10 * time.Second

// runContentScheduler promotes due scheduled drafts until the process stops.
//
// The pass is idempotent across replicas because the store transition is conditional
// on the draft status and revision; this loop only decides when to try.
func runContentScheduler(ctx context.Context, logger *slog.Logger, service *content.Service) {
	if service == nil {
		return
	}
	ticker := time.NewTicker(contentSchedulerInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			result, err := service.ProcessScheduledPublishing(ctx)
			if err != nil {
				logger.Error("scheduled publish pass failed", "error", err)
				continue
			}
			if result.Due > 0 {
				logger.Info("scheduled publish pass",
					"due", result.Due,
					"published", result.Published,
					"failed", result.Failed,
					"cancelled", result.Cancelled,
				)
			}
			// The recycle bin is swept on the same tick. Deletion is a cheap indexed
			// update of the rows that are past the retention window, and running it here
			// keeps one scheduler instead of two: an operator sees every content
			// lifecycle job in the same log stream.
			purged, purgeErr := service.ProcessTrashRetention(ctx)
			if purgeErr != nil {
				logger.Error("trash retention pass failed", "error", purgeErr)
				continue
			}
			if purged > 0 {
				logger.Info("trash retention pass", "purged", purged)
			}
		}
	}
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

// backupMediaRoots describes the media roots a backup package can walk.
//
// The global root keeps the alias "global"; a scope with its own local directory
// gets the scope name so restore puts its files back in the same place. Inherit
// scopes are covered by the global root, and S3 roots are recorded without a
// directory so the package reports them as not included.
func backupMediaRoots(cfg config.Config) []backup.MediaRoot {
	roots := make([]backup.MediaRoot, 0, 1+len(cfg.StorageScopes))
	seen := make(map[string]struct{}, 1+len(cfg.StorageScopes))
	record := func(alias, driver, dir, key string) {
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		roots = append(roots, backup.MediaRoot{Alias: alias, Driver: driver, Dir: dir})
	}
	add := func(alias, driver, dir string) {
		record(alias, driver, dir, driver+"\x00"+filepath.Clean(dir))
	}
	add("global", cfg.StorageDriver, cfg.StorageDir)
	for _, scope := range config.StorageScopeNames() {
		scopeCfg := cfg.StorageScopes[scope]
		switch scopeCfg.Driver {
		case config.StorageDriverLocal:
			add(scope, "local", scopeCfg.LocalDir)
		case config.StorageDriverS3:
			// S3 roots have no local directory: dedupe them by bucket and prefix.
			// Keying them on driver+dir alone collapses every S3 scope into the first
			// one, which hides the rest from the backup report.
			record(scope, "s3", "", "s3\x00"+scopeCfg.S3Bucket+"\x00"+scopeCfg.S3Prefix)
		}
	}
	return roots
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
