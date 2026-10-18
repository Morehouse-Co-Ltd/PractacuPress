package ginrouter

import (
	"context"
	"io"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// New builds the HTTP engine.
//
// Routes mounted here are only the ones that exist today; feature modules add
// their own route groups as they land.
func New(deps Dependencies) *gin.Engine {
	setGinMode(deps.Config.AppEnv)
	if deps.Logger == nil {
		deps.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/healthz", healthz)
	r.GET("/readyz", readyz(deps.Readiness))

	v1 := r.Group("/api/v1")
	v1.GET("/openapi.json", openAPIDocument)

	r.NoRoute(noRoute)

	return r
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

func noRoute(c *gin.Context) {
	p := apperr.NotFound("route").WithDetail("path", c.Request.URL.Path)
	middleware.AbortProblem(c, p)
}
