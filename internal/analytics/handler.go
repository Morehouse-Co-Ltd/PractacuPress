package analytics

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

// PrincipalFunc returns the authenticated caller.
type PrincipalFunc func(*gin.Context) (Actor, bool)

// SiteFunc returns the site resolved from the request host.
type SiteFunc func(*gin.Context) (site.Site, bool)

// HandlerConfig configures a Handler.
type HandlerConfig struct {
	// Principal resolves the caller of a report request.
	Principal PrincipalFunc
	// Site exposes the resolved site so anonymous visit writes know their tenant.
	Site SiteFunc
}

// Handler exposes analytics over HTTP.
type Handler struct {
	service   *Service
	principal PrincipalFunc
	site      SiteFunc
}

// NewHandler builds a Handler.
func NewHandler(service *Service, cfg HandlerConfig) *Handler {
	principal := cfg.Principal
	if principal == nil {
		principal = func(*gin.Context) (Actor, bool) { return Actor{}, false }
	}
	siteOf := cfg.Site
	if siteOf == nil {
		siteOf = func(*gin.Context) (site.Site, bool) { return site.Site{}, false }
	}
	return &Handler{service: service, principal: principal, site: siteOf}
}

// Routes mounts the analytics endpoints under /api/v1.
//
// Recording a visit is anonymous; reading a report requires a session, which is
// enforced by the guard passed to the group.
func (h *Handler) Routes(r gin.IRouter, requireAuth, optionalAuth gin.HandlerFunc) {
	r.POST("/analytics/visits", optionalAuth, h.RecordVisit)

	group := r.Group("/sites/:siteID/analytics", requireAuth)
	group.GET("", h.Report)
}

type visitRequest struct {
	Path     string `json:"path"`
	Title    string `json:"title"`
	Referrer string `json:"referrer"`
	Session  string `json:"session"`
	Surface  string `json:"surface"`
}

type totalsResponse struct {
	Views    int `json:"views"`
	Sessions int `json:"sessions"`
	Online   int `json:"online"`
}

type pointResponse struct {
	Label string `json:"label"`
	Count int    `json:"count"`
}

type topPageResponse struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

type topContentResponse struct {
	ID    string `json:"id"`
	Count int    `json:"count"`
}

type sourceResponse struct {
	Source   string `json:"source"`
	Visits   int    `json:"visits"`
	Sessions int    `json:"sessions"`
}

type deviceResponse struct {
	Device   string `json:"device"`
	Visits   int    `json:"visits"`
	Sessions int    `json:"sessions"`
}

type referrerResponse struct {
	Host   string `json:"host"`
	Visits int    `json:"visits"`
}

type retentionResponse struct {
	Date              string `json:"date"`
	NewSessions       int    `json:"new_sessions"`
	ReturningSessions int    `json:"returning_sessions"`
}

type recentVisitResponse struct {
	Path      string `json:"path"`
	Title     string `json:"title"`
	Referrer  string `json:"referrer"`
	Session   string `json:"session"`
	CreatedAt string `json:"created_at"`
}

type reportResponse struct {
	Range        string                `json:"range"`
	Totals       totalsResponse        `json:"totals"`
	Series       []pointResponse       `json:"series"`
	TopPages     []topPageResponse     `json:"top_pages"`
	TopContent   []topContentResponse  `json:"top_content"`
	Recent       []recentVisitResponse `json:"recent"`
	Sources      []sourceResponse      `json:"sources"`
	Devices      []deviceResponse      `json:"devices"`
	TopReferrers []referrerResponse    `json:"top_referrers"`
	Retention    []retentionResponse   `json:"retention"`
}

// RecordVisit stores one page view and answers 204.
//
// The site always comes from host resolution, never from the body: a browser must
// not be able to attribute traffic to another tenant. A members-only site only
// accepts writes from a session scoped to that site, because its pages are not
// readable by anonymous visitors in the first place; accepting their writes would let
// a stranger inject rows into an administrator's report.
func (h *Handler) RecordVisit(c *gin.Context) {
	resolved, ok := h.site(c)
	if !ok {
		_ = c.Error(apperr.New(apperr.CodeSiteNotFound).WithRequestID(c.GetHeader("X-Request-ID")))
		return
	}
	if resolved.IsMembersOnly() {
		principal, authenticated := h.principal(c)
		if !authenticated || principal.SiteID != resolved.ID {
			_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "members_only_site"))
			return
		}
	}

	var req visitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	// Source, referrer host and device are derived on the server. The body referrer
	// comes first: the tracking POST is a same-origin beacon, so its Referer header is
	// the tracked page itself and would classify every real external entry as
	// internal. The front end sends document.referrer in the body, and the header is
	// only a fallback for clients that omit it. The request host and the configured
	// domain both identify this site so a same-site referrer stays internal.
	signals := DeriveVisitSignals(
		req.Referrer,
		c.GetHeader("Referer"),
		c.GetHeader("User-Agent"),
		c.Request.Host,
		resolved.Domain,
	)

	err := h.service.Record(c.Request.Context(), resolved.ID, VisitInput{
		Path:     req.Path,
		Title:    req.Title,
		Referrer: req.Referrer,
		Session:  req.Session,
		Surface:  Surface(req.Surface),
		Signals:  signals,
	})
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.Status(http.StatusNoContent)
}

// Report returns the dashboard payload for one site and range.
func (h *Handler) Report(c *gin.Context) {
	actor, ok := h.principal(c)
	if !ok {
		h.unauthenticated(c)
		return
	}

	rangeValue, err := ParseRange(c.Query("range"))
	if err != nil {
		_ = c.Error(apperr.Validation("range must be one of 24h, 7d, 30d"))
		return
	}

	offset := 0
	if raw := c.Query("tz_offset"); raw != "" {
		parsed, convErr := strconv.Atoi(raw)
		if convErr != nil || parsed < -14*60 || parsed > 14*60 {
			_ = c.Error(apperr.Validation("tz_offset must be minutes between -840 and 840"))
			return
		}
		offset = parsed
	}

	report, err := h.service.Report(c.Request.Context(), actor, c.Param("siteID"), rangeValue, offset)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	c.JSON(http.StatusOK, toReportResponse(report))
}

func (h *Handler) unauthenticated(c *gin.Context) {
	_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
}

func toReportResponse(report Report) reportResponse {
	series := make([]pointResponse, 0, len(report.Series))
	for _, point := range report.Series {
		series = append(series, pointResponse{Label: point.Label, Count: point.Count})
	}

	pages := make([]topPageResponse, 0, len(report.TopPages))
	for _, page := range report.TopPages {
		pages = append(pages, topPageResponse{Path: page.Path, Count: page.Count})
	}

	content := make([]topContentResponse, 0, len(report.TopContent))
	for _, item := range report.TopContent {
		content = append(content, topContentResponse{ID: item.ID, Count: item.Count})
	}

	recent := make([]recentVisitResponse, 0, len(report.Recent))
	for _, visit := range report.Recent {
		recent = append(recent, recentVisitResponse{
			Path:      visit.Path,
			Title:     visit.Title,
			Referrer:  visit.Referrer,
			Session:   visit.Session,
			CreatedAt: visit.CreatedAt.UTC().Format(time.RFC3339),
		})
	}

	sources := make([]sourceResponse, 0, len(report.Sources))
	for _, item := range report.Sources {
		sources = append(sources, sourceResponse{
			Source:   string(item.Source),
			Visits:   item.Visits,
			Sessions: item.Sessions,
		})
	}

	devices := make([]deviceResponse, 0, len(report.Devices))
	for _, item := range report.Devices {
		devices = append(devices, deviceResponse{
			Device:   string(item.Device),
			Visits:   item.Visits,
			Sessions: item.Sessions,
		})
	}

	referrers := make([]referrerResponse, 0, len(report.TopReferrers))
	for _, item := range report.TopReferrers {
		referrers = append(referrers, referrerResponse{Host: item.Host, Visits: item.Visits})
	}

	retention := make([]retentionResponse, 0, len(report.Retention))
	for _, item := range report.Retention {
		retention = append(retention, retentionResponse{
			Date:              item.Date,
			NewSessions:       item.NewSessions,
			ReturningSessions: item.ReturningSessions,
		})
	}

	return reportResponse{
		Range:        string(report.Range),
		Totals:       totalsResponse{Views: report.Totals.Views, Sessions: report.Totals.Sessions, Online: report.Totals.Online},
		Series:       series,
		TopPages:     pages,
		TopContent:   content,
		Recent:       recent,
		Sources:      sources,
		Devices:      devices,
		TopReferrers: referrers,
		Retention:    retention,
	}
}

// mapError translates analytics failures into the API error model.
func mapError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil

	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation("invalid analytics request")

	case errors.Is(err, ErrCrossSite):
		return apperr.PermissionDenied().WithDetail("reason", "cross_site")

	case errors.Is(err, ErrPermissionDenied):
		return apperr.PermissionDenied()

	case errors.Is(err, ErrNotFound):
		return apperr.NotFound("analytics")
	}

	var problem *apperr.Problem
	if errors.As(err, &problem) {
		return problem
	}
	return apperr.Internal(err)
}
