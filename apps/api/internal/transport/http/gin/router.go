package ginrouter

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/media"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
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
		middleware.Recovery(deps.Logger),
		middleware.ErrorHandler(deps.Logger),
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

	v1 := r.Group("/api/v1")
	if deps.SiteResolver != nil {
		v1.Use(middleware.ResolveSite(trusted, deps.SiteResolver))
	}
	v1.GET("/openapi.json", openAPIDocument)

	if deps.Auth != nil || deps.Sites != nil || deps.Content != nil || deps.Community != nil || deps.Media != nil || deps.Events != nil || deps.Notifications != nil || deps.Messages != nil || deps.WS != nil || deps.Analytics != nil || deps.Taxonomy != nil {
		var guard, optionalAuth gin.HandlerFunc
		if deps.AccessTokens != nil {
			// The guard binds the token to the resolved site: a token minted on site A
			// must never authenticate a request for site B, whose hostname is what
			// selected the tenant in the first place.
			guard = middleware.RequireAuthForSite(deps.AccessTokens)
			optionalAuth = middleware.OptionalAuth(deps.AccessTokens)
		} else {
			guard = func(c *gin.Context) {
				middleware.AbortProblem(c, apperr.Unauthenticated().
					WithDetail("reason", "auth_not_configured").
					WithRequestID(middleware.RequestIDFrom(c)))
			}
			optionalAuth = func(c *gin.Context) { c.Next() }
		}
		if deps.Auth != nil {
			deps.Auth.Routes(v1, guard)
		}
		if deps.Sites != nil {
			deps.Sites.Routes(v1, guard, optionalAuth)
		}
		if deps.Content != nil {
			deps.Content.Routes(v1, guard, optionalAuth)
		}
		if deps.Community != nil {
			deps.Community.Routes(v1, guard, optionalAuth)
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
	}

	r.NoRoute(noRoute)

	return r
}

// configureTrustedProxies tells Gin which peers may supply the client IP.
//
// With no configured proxy every forwarding header is ignored and ClientIP falls
// back to the socket address, which is the only safe default.
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

// openAPIDocument serves the contract without requiring a session. The document
// is replaced by the generated contract once packages/contracts lands.
func openAPIDocument(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"openapi": "3.1.0",
		"info": gin.H{
			"title":   "Practacu Press API",
			"version": "0.1.0",
		},
		"servers": []gin.H{{"url": "/api/v1"}},
		"paths":   gin.H{},
	})
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
		if status.Reason != "" {
			body["reason"] = status.Reason
		}
		if status.SiteID != "" {
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
