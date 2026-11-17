package ginrouter

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/backup"
	"github.com/practacu/practacu-press/apps/api/internal/feed"
	"github.com/practacu/practacu-press/apps/api/internal/media"
	"github.com/practacu/practacu-press/apps/api/internal/observability"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/plugins"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/apidocs"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
	"github.com/practacu/practacu-press/packages/contracts/openapi"
)

// New builds the HTTP engine.
//
// Middleware order matters and is fixed here: request id first so every later
// component can correlate, then the error translator so failures from any inner
// middleware are formatted, then CORS (browsers must get a preflight answer before
// being rate limited), then rate limiting.
func New(deps Dependencies) *gin.Engine {
	setGinMode(deps.Config.AppEnv)
	if deps.Logger == nil {
		deps.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	r := gin.New()
	configureTrustedProxies(r, deps.Config.TrustedProxies)

	r.Use(
		middleware.RequestID(),
		// The request log sits directly after the id and before the error translator:
		// it reads the final status after c.Next() returns, which is only final once
		// every inner middleware, including the error handler, has run.
		requestLogMiddleware(deps.RequestLog),
		middleware.Recovery(deps.Logger),
		middleware.ErrorHandler(deps.Logger),
		// Browser security headers run before any handler so aborted and error
		// responses carry them too; a CSP only on 200s protects nothing.
		middleware.SecurityHeaders(),
		// Compression runs after the security headers so a 304 or an error still
		// carries them; it sits before handlers so every JSON body benefits. The
		// desktop build talks to this process directly, so this is the only thing
		// shrinking the design document on its way to a visitor.
		middleware.Gzip(),
	)

	// Bound request work and body size before anything else reads them. The two
	// streaming routes (the socket and media downloads) opt out of the deadline: they
	// are long lived by design, which is also why the server sets no global WriteTimeout.
	if deps.Config.HTTPRequestTimeout > 0 {
		r.Use(middleware.RequestTimeout(deps.Config.HTTPRequestTimeout, middleware.LongLivedRequests))
	}
	if deps.Config.MaxRequestBodyBytes > 0 {
		r.Use(middleware.BodyLimit(
			deps.Config.MaxRequestBodyBytes,
			// The upload endpoint is the one route that legitimately carries megabytes:
			// its ceiling is the media module's attachment limit plus multipart framing.
			middleware.BodyLimitRule{
				Prefix: "/api/v1/media/uploads/",
				Limit:  media.MaxAttachmentBytes + (1 << 20),
			},
			// A whole-site import is a zip package, not a JSON body. It has its own
			// documented ceiling instead of sharing the ordinary request limit.
			middleware.BodyLimitRule{
				Suffix: "/import",
				Limit:  backup.MaxImportBytes,
			},
		))
	}

	if len(deps.Config.CORSAllowedOrigins) > 0 {
		r.Use(middleware.CORS(middleware.CORSConfig{
			AllowedOrigins:   deps.Config.CORSAllowedOrigins,
			AllowCredentials: deps.Config.CORSCredentials,
		}))
	}

	if deps.Config.RateLimitPerMinute > 0 {
		r.Use(middleware.RateLimit(
			middleware.NewMemoryRateLimitStore(nil),
			middleware.Policy{Limit: deps.Config.RateLimitPerMinute, Window: time.Minute},
		))
	}

	// Trusted proxies are resolved once: both the setup status endpoint and the
	// site resolver middleware need them, and a configuration error must fail the
	// same way for both.
	trusted, err := middleware.NewTrustedProxies(deps.Config.TrustedProxies)
	if err != nil {
		// Load validates this at startup; reaching here means the caller built
		// Config by hand, which is a programming error worth failing loudly.
		panic(fmt.Sprintf("ginrouter: %v", err))
	}

	r.GET("/healthz", healthz)
	r.GET("/readyz", readyz(deps.Readiness))
	// Mounted on the engine rather than the versioned group on purpose: the group
	// rejects a request before any handler when no site resolves, and "no site" is
	// exactly what this endpoint has to report. The full path stays under /api/v1
	// so clients and the contract see one prefix.
	r.GET("/api/v1/setup/status", setupStatus(deps.Install, trusted))

	// The contract and its reference page are host independent, so they sit outside
	// the site-resolving group. The document is embedded in the binary; the page is
	// self hosted so it works on an offline desktop install and under the strict CSP.
	r.GET("/api/v1/openapi.json", openAPIDocument(deps.Plugins))
	r.GET("/api/v1/docs", apiReferencePage)
	r.GET("/api/v1/docs/app.css", apiReferenceAsset("app.css", "text/css; charset=utf-8"))
	r.GET("/api/v1/docs/app.js", apiReferenceAsset("app.js", "text/javascript; charset=utf-8"))

	// Crawler files and feeds live at the site root, but the content behind them is per
	// site: the same route serves a different sitemap, robots.txt and feed on every
	// configured hostname. The resolver is built once because all three share it.
	var resolveSite gin.HandlerFunc
	if deps.SiteResolver != nil {
		resolveSite = middleware.ResolveSite(trusted, deps.SiteResolver)
	}
	// The IP allow and deny lists belong to the resolved site, so the guard sits right
	// after resolution on every site-bound route. The site-root files (sitemap, robots
	// and feeds) resolve the site per route, so they carry the same guard.
	var siteIPGuard gin.HandlerFunc
	if deps.IPPolicy != nil {
		siteIPGuard = middleware.SiteIPGuard(deps.IPPolicy)
	}
	siteChain := func(handler gin.HandlerFunc) []gin.HandlerFunc {
		chain := make([]gin.HandlerFunc, 0, 3)
		if resolveSite != nil {
			chain = append(chain, resolveSite)
		}
		if siteIPGuard != nil {
			chain = append(chain, siteIPGuard)
		}
		return append(chain, handler)
	}
	if resolveSite != nil &&
		deps.SiteFiles.Customization != nil &&
		deps.SiteFiles.Content != nil {
		r.GET("/sitemap.xml", siteChain(sitemapFile(deps.SiteFiles, trusted))...)
		r.GET("/robots.txt", siteChain(robotsFile(deps.SiteFiles, trusted))...)
	}
	if resolveSite != nil && deps.Feed.Customization != nil && deps.Feed.Content != nil {
		r.GET("/rss.xml", siteChain(feedFile(deps.Feed, trusted, feed.FormatRSS, feed.ScopeSite))...)
		r.GET("/atom.xml", siteChain(feedFile(deps.Feed, trusted, feed.FormatAtom, feed.ScopeSite))...)
		// The implementation plan names /feed.xml; it is an alias of the RSS feed so a
		// reader configured before /rss.xml became canonical keeps working.
		r.GET("/feed.xml", siteChain(feedFile(deps.Feed, trusted, feed.FormatRSS, feed.ScopeSite))...)
		r.GET("/category/:slug/rss.xml", siteChain(feedFile(deps.Feed, trusted, feed.FormatRSS, feed.ScopeCategory))...)
		r.GET("/category/:slug/atom.xml", siteChain(feedFile(deps.Feed, trusted, feed.FormatAtom, feed.ScopeCategory))...)
		r.GET("/tag/:slug/rss.xml", siteChain(feedFile(deps.Feed, trusted, feed.FormatRSS, feed.ScopeTag))...)
		r.GET("/tag/:slug/atom.xml", siteChain(feedFile(deps.Feed, trusted, feed.FormatAtom, feed.ScopeTag))...)
	}

	v1 := r.Group("/api/v1")
	if resolveSite != nil {
		v1.Use(resolveSite)
	}
	if siteIPGuard != nil {
		v1.Use(siteIPGuard)
	}
	// Site level CORS sits after host resolution because the allowed origin list belongs
	// to the site the hostname selected. The deployment wide CORS middleware cannot do
	// this job: it is mounted on the engine, before any site exists, so a site owner
	// editing the list in the dashboard was changing a value nothing applied.
	if deps.SiteCORSOrigins != nil {
		v1.Use(middleware.SiteCORS(func(c *gin.Context) []string {
			resolved, ok := middleware.SiteFrom(c)
			if !ok {
				return nil
			}
			origins, err := deps.SiteCORSOrigins(c.Request.Context(), resolved.ID)
			if err != nil {
				// A failed lookup must not widen access: no site level origins means the
				// deployment policy alone decides, which is the pre Beta 1.2 behaviour.
				return nil
			}
			return origins
		}))
	}

	if deps.Auth != nil || deps.Sites != nil || deps.Platform != nil || deps.Content != nil || deps.Community != nil || deps.Reports != nil || deps.Media != nil || deps.Events != nil || deps.Notifications != nil || deps.Messages != nil || deps.WS != nil || deps.Analytics != nil || deps.Taxonomy != nil || deps.Audit != nil || deps.Safety != nil || deps.Backups != nil || deps.Captcha != nil || deps.System != nil || deps.Extensions != nil || deps.Redirect != nil || deps.Ops != nil || deps.BackupSchedule != nil || deps.Newsletter != nil {
		var guard, optionalAuth gin.HandlerFunc
		if deps.AccessTokens != nil {
			// The guard binds the token to the resolved site: a token minted on site A
			// must never authenticate a request for site B, whose hostname is what
			// selected the tenant in the first place. The membership resolver then
			// replaces the token's role with the live role and rejects a caller whose
			// membership was suspended or removed, so revocation is immediate.
			guard = middleware.RequireAuthForSite(deps.AccessTokens, deps.Memberships)
			optionalAuth = middleware.OptionalAuth(deps.AccessTokens, deps.Memberships)
			// The live membership carries the site's capability matrix. Enforcing
			// it in the same guard slot keeps every module honest without each one
			// repeating the path-to-capability mapping.
			if deps.Memberships != nil {
				guard = middleware.RequireAuthForSiteWithCapabilities(deps.AccessTokens, deps.Memberships)
			}
		} else {
			guard = func(c *gin.Context) {
				middleware.AbortProblem(c, apperr.Unauthenticated().
					WithDetail("reason", "auth_not_configured").
					WithRequestID(middleware.RequestIDFrom(c)))
			}
			optionalAuth = func(c *gin.Context) { c.Next() }
		}
		// The step-up guard runs after the authentication guard: it needs the
		// principal and only acts on the frozen list of high threat operations.
		stepUpGuard := StepUpGuard(deps.StepUp.Enforcer)
		if deps.Auth != nil {
			deps.Auth.Routes(v1, guard, stepUpGuard)
			// Beta 1.2 phone sign-in. Mounted separately so a deployment that never
			// configures an SMS gateway keeps its previous route table byte for byte.
			deps.Auth.PhoneRoutes(v1)
		}
		if deps.Captcha != nil {
			// Public on purpose: a visitor's login form has to know whether a
			// challenge is required before it has a session. The payload holds the
			// public site key and booleans only.
			deps.Captcha.Routes(v1)
		}
		if deps.Audit != nil {
			deps.Audit.Routes(v1, guard)
		}
		if deps.Sites != nil {
			deps.Sites.Routes(v1, guard, optionalAuth, stepUpGuard)
		}
		if deps.Platform != nil {
			deps.Platform.Routes(v1, guard)
		}
		if deps.Content != nil {
			deps.Content.Routes(v1, guard, optionalAuth)
		}
		if deps.Community != nil {
			deps.Community.Routes(v1, guard, optionalAuth)
		}
		if deps.Reports != nil {
			deps.Reports.Routes(v1, guard)
		}
		if deps.Media != nil {
			deps.Media.Routes(v1, guard, optionalAuth)
		}
		if deps.WS != nil {
			deps.WS.Routes(v1, guard)
		}
		if deps.Messages != nil {
			deps.Messages.Routes(v1, guard)
		}
		if deps.Notifications != nil {
			deps.Notifications.Routes(v1, guard)
		}
		if deps.Events != nil {
			deps.Events.Routes(v1, guard)
		}
		if deps.Analytics != nil {
			deps.Analytics.Routes(v1, guard, optionalAuth)
		}
		if deps.Taxonomy != nil {
			deps.Taxonomy.Routes(v1, guard, optionalAuth)
		}
		if deps.Safety != nil {
			deps.Safety.Routes(v1, guard, stepUpGuard)
		}
		if deps.Backups != nil {
			deps.Backups.Routes(v1, guard, stepUpGuard)
		}
		if deps.System != nil {
			// Deployment wide resource panel; the handler itself requires a platform
			// administrator seat, because the payload names host paths and processes.
			deps.System.Routes(v1, guard)
			// Beta 1.2: what the process actually loaded, as opposed to what the storage
			// and access pages recorded. Mounted separately so the resource panel can be
			// switched off without taking this away.
			deps.System.RoutesEffectiveConfig(v1, guard)
		}
		if deps.Redirect != nil {
			// /resolve is public: the page server calls it before rendering, and a
			// crawler reaches it without a session. The redirect rules themselves sit
			// behind the same guard as every other site administration route.
			deps.Redirect.Routes(v1, guard)
		}
		if deps.Ops != nil {
			// Request log, queue status and the manual retry action.
			deps.Ops.Routes(v1, guard)
		}
		if deps.BackupSchedule != nil {
			// The schedule the process actually runs with, plus its artifacts.
			deps.BackupSchedule.Routes(v1, guard)
		}
		if deps.Newsletter != nil {
			// Public subscription endpoints, the account preference, and the site
			// administration surface for subscribers, templates, logs and sending.
			deps.Newsletter.Routes(v1, guard)
		}
		if deps.Extensions != nil {
			// Extension administration is deployment scoped for the same reason: a
			// package can run server side code. The handler enforces the platform
			// administrator seat because the guard is site scoped.
			deps.Extensions.Routes(v1, guard)
		}
	}

	// Plugins are an opt-in composition. Nil keeps every route above unchanged and
	// leaves the shipped contract byte-for-byte as it was; a wired host adds a
	// public boot manifest, a namespaced API and the browser bundles.
	if deps.Plugins != nil {
		pluginAuth := gin.HandlerFunc(func(c *gin.Context) { c.Next() })
		if deps.AccessTokens != nil {
			pluginAuth = middleware.OptionalAuth(deps.AccessTokens, deps.Memberships)
		}
		// The boot manifest is public by design: the browser needs the list before
		// it has a session. It contains names, versions, slots and permissions, never
		// server paths or settings values.
		v1.GET("/plugins", func(c *gin.Context) {
			c.Header("Cache-Control", "no-store")
			c.JSON(http.StatusOK, gin.H{"plugins": deps.Plugins.PublicPlugins()})
		})
		v1.Any("/plugins/:pluginID/*path",
			pluginAuth,
			pluginRequestInfo,
			gin.WrapH(deps.Plugins.APIHandler("/api/v1/plugins/")),
		)
		// Browser bundles are versioned in the URL, so they are safe to cache
		// immutably. They sit at the root because the launcher's CSP already allows
		// same-origin scripts and the SPA's base path is the document root.
		r.GET("/plugins/:pluginID/:version/*path",
			gin.WrapH(deps.Plugins.AssetHandler("/plugins/")),
		)
	}

	// Third party login. The two endpoints are anonymous by design: the visitor has no
	// session yet, so neither a guard nor optional auth belongs on them. They stay
	// inside the versioned group because the callback URI and the landing page are
	// derived from the site the browser started on, which the resolver put on the
	// request already.
	if deps.OAuth != nil {
		var sessions sessionCookieWriter
		if deps.Auth != nil {
			// The session a provider login hands out is the password login's session;
			// the auth handler owns the cookie layout, so the issuer writes through it.
			sessions = deps.Auth
		}
		oauth := v1.Group("")
		oauth.Use(oauthSessionContext(deps.Config.DefaultSiteID, sessions))
		oauth.GET("/auth/oauth/:provider/start", deps.OAuth.Start)
		oauth.GET("/auth/oauth/:provider/callback", deps.OAuth.Callback)
	}

	r.NoRoute(noRoute)

	return r
}

// configureTrustedProxies tells Gin which peers may supply the client IP.
//
// With no configured proxy every forwarding header is ignored and ClientIP falls
// back to the socket address, which is the only safe default.
// requestLogMiddleware enables the operator request log when a recorder is wired.
//
// A nil recorder yields a pass through handler rather than a nil entry in r.Use,
// which gin would panic on. Tests that build a router without a recorder therefore
// keep working unchanged.
func requestLogMiddleware(recorder *observability.Recorder) gin.HandlerFunc {
	if recorder == nil {
		return func(c *gin.Context) { c.Next() }
	}
	return recorder.Middleware()
}

func configureTrustedProxies(r *gin.Engine, trusted []string) {
	if len(trusted) == 0 {
		_ = r.SetTrustedProxies(nil)
		return
	}
	_ = r.SetTrustedProxies(trusted)
}

func setGinMode(appEnv string) {
	switch appEnv {
	case config.EnvProduction:
		gin.SetMode(gin.ReleaseMode)
	case config.EnvTest:
		gin.SetMode(gin.TestMode)
	default:
		gin.SetMode(gin.DebugMode)
	}
}

// healthz reports process liveness only. It must never depend on the database or
// on any upstream service, otherwise a dependency outage would restart the pod.
func healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// readyz reports whether the process can serve traffic. Readiness, unlike
// liveness, may fail while dependencies recover.
func readyz(check func(context.Context) error) gin.HandlerFunc {
	return func(c *gin.Context) {
		if check != nil {
			if err := check(c.Request.Context()); err != nil {
				c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unready"})
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	}
}

// openAPIDocument serves the contract the repository ships, composed with the
// enabled plugins' operations when a plugin host is wired.
//
// The base document is embedded at build time, so the endpoint needs no
// database, no filesystem and no session: it is the same bytes the contract
// tests check against packages/contracts/openapi/openapi.yaml.
func openAPIDocument(provider *plugins.Host) gin.HandlerFunc {
	return func(c *gin.Context) {
		var document []byte
		var err error
		if provider != nil {
			document, err = provider.ContractJSON()
		} else {
			document, err = openapi.JSON()
		}
		if err != nil {
			_ = c.Error(apperr.Internal(err).WithRequestID(middleware.RequestIDFrom(c)))
			return
		}
		c.Header("Cache-Control", "public, max-age=300")
		c.Data(http.StatusOK, "application/json; charset=utf-8", document)
	}
}

// pluginRequestInfo puts the resolved site and principal where the plugin host
// expects them. The host stays transport agnostic; this adapter is the only
// place that knows about gin's context keys.
func pluginRequestInfo(c *gin.Context) {
	info := plugins.RequestInfo{}
	if resolved, ok := middleware.SiteFrom(c); ok {
		info.SiteID = resolved.ID
	}
	if principal, ok := middleware.PrincipalFrom(c); ok {
		info.Authenticated = true
		info.UserID = principal.UserID
		info.Role = string(principal.Role)
	}
	c.Request = c.Request.WithContext(plugins.WithRequestInfo(c.Request.Context(), info))
	c.Next()
}

// apiReferencePage serves the self-hosted API reference.
func apiReferencePage(c *gin.Context) {
	page, err := apidocs.Read("index.html")
	if err != nil {
		_ = c.Error(apperr.Internal(err).WithRequestID(middleware.RequestIDFrom(c)))
		return
	}
	c.Header("Cache-Control", "public, max-age=300")
	c.Data(http.StatusOK, "text/html; charset=utf-8", page)
}

// apiReferenceAsset serves one embedded asset of the reference page.
//
// The names are fixed by the embed directive, so the handler cannot become a path
// traversal sink.
func apiReferenceAsset(name, contentType string) gin.HandlerFunc {
	return func(c *gin.Context) {
		asset, err := apidocs.Read(name)
		if err != nil {
			_ = c.Error(apperr.Internal(err).WithRequestID(middleware.RequestIDFrom(c)))
			return
		}
		c.Header("Cache-Control", "public, max-age=300")
		c.Data(http.StatusOK, contentType, asset)
	}
}

// setupStatus tells a browser whether the install it remembers still exists.
//
// The frontend stores its install configuration in localStorage, which survives a
// deleted data directory. When the server has no site (or a different one) the page
// would otherwise render an empty site and the wizard would be unreachable, so this
// endpoint is the tie breaker. It is public: it exposes the site id and name, both
// of which the page already renders, and nothing about members.
func setupStatus(report InstallReporter, trusted middleware.TrustedProxies) gin.HandlerFunc {
	return func(c *gin.Context) {
		if report == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"installed": false,
				"reason":    "not_configured",
			})
			return
		}

		status, err := report.InstallStatus(c.Request.Context(), middleware.RequestHost(c, trusted))
		if err != nil {
			problem := apperr.Internal(err).WithRequestID(middleware.RequestIDFrom(c))
			middleware.AbortProblem(c, problem)
			return
		}

		body := gin.H{"installed": status.Installed, "has_admin": status.HasAdmin}
		if status.Installed {
			// O-3: visitor-facing clients hide the register entry point when the site
			// has closed self-service sign-ups. Only meaningful for an installed site.
			body["registration_open"] = status.RegistrationOpen
		}
		if status.Reason != "" {
			body["reason"] = status.Reason
		}
		if status.SiteID != "" {
			// The site id and name are needed by an anonymous visitor bootstrapping the
			// public site (V-09 accepted residual: the name is public branding anyway).
			body["site_id"] = status.SiteID
			body["site_name"] = status.SiteName
		}
		c.JSON(http.StatusOK, body)
	}
}

func noRoute(c *gin.Context) {
	problem := apperr.NotFound("route").
		WithDetail("path", c.Request.URL.Path).
		WithRequestID(middleware.RequestIDFrom(c))
	middleware.AbortProblem(c, problem)
}
