// Package contract keeps the OpenAPI document and the running router in step.
//
// The document is the cross team source of truth, so drift in either direction is a
// release blocker: an undocumented route is invisible to the frontend team, and a
// documented route that does not exist is a promise the server cannot keep.
package ginrouter_test

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"github.com/practacu/practacu-press/internal/analytics"
	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/backup"
	"github.com/practacu/practacu-press/internal/captcha"
	"github.com/practacu/practacu-press/internal/community"
	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/extensions"
	"github.com/practacu/practacu-press/internal/media"
	"github.com/practacu/practacu-press/internal/messaging"
	"github.com/practacu/practacu-press/internal/moderation"
	"github.com/practacu/practacu-press/internal/newsletter"
	"github.com/practacu/practacu-press/internal/notifications"
	"github.com/practacu/practacu-press/internal/outbox"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/platformadmin"
	"github.com/practacu/practacu-press/internal/redirect"
	"github.com/practacu/practacu-press/internal/safety"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/system"
	"github.com/practacu/practacu-press/internal/taxonomy"
	ginrouter "github.com/practacu/practacu-press/internal/transport/http/gin"
	"github.com/practacu/practacu-press/internal/transport/ws"
)

const docPath = "internal/packages/contracts/openapi/openapi.yaml"

type document struct {
	Paths      map[string]map[string]operation `yaml:"paths"`
	Components struct {
		Schemas map[string]struct {
			Properties map[string]struct {
				Enum []string `yaml:"enum"`
			} `yaml:"properties"`
		} `yaml:"schemas"`
	} `yaml:"components"`
	Servers []struct {
		URL string `yaml:"url"`
	} `yaml:"servers"`
}

type operation struct {
	Summary   string              `yaml:"summary"`
	Responses map[string]response `yaml:"responses"`
	Security  *[]any              `yaml:"security"`
	Servers   []struct {
		URL string `yaml:"url"`
	} `yaml:"servers"`
	Deprecated bool `yaml:"deprecated"`
}

type response struct {
	Description string `yaml:"description"`
}

// repoRoot walks up from the test working directory to the module root.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	require.NoError(t, err)

	for {
		if _, statErr := os.Stat(filepath.Join(dir, "go.mod")); statErr == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		require.NotEqual(t, parent, dir, "go.mod not found above the test directory")
		dir = parent
	}
}

func loadDocument(t *testing.T) document {
	t.Helper()

	raw, err := os.ReadFile(filepath.Join(repoRoot(t), docPath))
	require.NoError(t, err)

	var doc document
	require.NoError(t, yaml.Unmarshal(raw, &doc))
	require.NotEmpty(t, doc.Paths)
	return doc
}

// fullPath maps a document path to the path the router serves.
//
// Most of the contract lives under the `/api/v1` server. Root files (health probes,
// sitemap.xml, robots.txt and the syndication feeds) declare `servers: [{url: /}]` on
// their operation, which is how OpenAPI describes a resource outside the API prefix.
func fullPath(docPathValue string, op operation) string {
	for _, server := range op.Servers {
		if server.URL == "/" {
			return docPathValue
		}
	}
	return "/api/v1" + docPathValue
}

// routeKey is one method plus one normalised path.
type routeKey struct {
	Method string
	Path   string
}

// buildRouter mounts every handler. The services are nil on purpose: mounting only
// registers routes, so no database or handler dependencies are needed to inspect them.
func buildRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)

	return ginrouter.New(ginrouter.Dependencies{
		Config:       config.Config{AppEnv: config.EnvTest},
		SiteResolver: contractSiteResolver{},
		Auth:         auth.NewHandler(nil, auth.HandlerConfig{}),
		// Third party login is documented, so the partial router mounts it too. The
		// dependencies are empty on purpose: mounting only registers the two routes.
		OAuth: auth.NewOAuthHandler(auth.OAuthHandlerDeps{}),
		// The captcha status endpoint is public but still part of the contract.
		Captcha:       captcha.NewHandler(captcha.HandlerConfig{}),
		Audit:         audit.NewHandler(nil, audit.HandlerConfig{}),
		Sites:         site.NewHandler(nil, site.HandlerConfig{}),
		Platform:      platformadmin.NewHandler(nil, platformadmin.HandlerConfig{}),
		Content:       content.NewHandler(nil, content.HandlerConfig{}),
		Community:     community.NewHandler(nil, community.HandlerConfig{}),
		Reports:       moderation.NewHandler(nil, moderation.HandlerConfig{}),
		Media:         media.NewHandler(nil, media.HandlerConfig{}),
		Events:        outbox.NewEventsHandler(nil, outbox.HandlerConfig{}),
		Notifications: notifications.NewHandler(nil, notifications.HandlerConfig{}),
		Messages:      messaging.NewHandler(nil, messaging.HandlerConfig{}),
		WS:            ws.NewHandler(ws.NewTicketStore(nil), ws.NewHub(), ws.HandlerConfig{}),
		Analytics:     analytics.NewHandler(nil, analytics.HandlerConfig{}),
		Taxonomy:      taxonomy.NewHandler(nil, taxonomy.HandlerConfig{}),
		Safety:        safety.NewHandler(nil, safety.HandlerConfig{}),
		Backups:       backup.NewHandler(nil, backup.HandlerConfig{}),
		// The optional resource panel is documented, so the contract router mounts it
		// with an inert snapshot source; no request reaches it here.
		System: system.NewHandler(
			func() system.Snapshot { return system.Snapshot{} },
			system.HandlerConfig{},
		),
		// Extension administration is documented, so the contract router mounts the
		// routes with an inert service. No request reaches it here either.
		Extensions: extensions.NewHandler(contractExtensionsService{}, extensions.HandlerConfig{}),
		// The root syndication routes are part of the contract, so the partial router
		// this test inspects has to mount them. The readers are inert stubs: no request
		// reaches them here.
		Feed: ginrouter.FeedDependencies{
			Customization: contractCustomization{},
			Content:       contractContentLister{},
		},
		// Beta 1.2 modules. Each is mounted with an inert service: registering the
		// routes is the whole point here, and no request reaches a handler.
		Redirect:       redirect.NewHandler(nil, redirect.HandlerConfig{}),
		Ops:            system.NewOpsHandler(nil, nil, system.OpsHandlerConfig{}),
		BackupSchedule: backup.NewScheduleHandler(nil, backup.ScheduleHandlerConfig{}),
		Newsletter:     newsletter.NewHandler(nil, newsletter.HandlerConfig{}),
	})
}

type contractSiteResolver struct{}

func (contractSiteResolver) Resolve(context.Context, string) (site.Site, error) {
	return site.Site{ID: "site_contract", Name: "Contract"}, nil
}

type contractCustomization struct{}

func (contractCustomization) Customization(context.Context, string) (site.Customization, error) {
	return site.Customization{}, nil
}

type contractContentLister struct{}

func (contractContentLister) ListAfterFilter(
	context.Context,
	content.Actor,
	content.Kind,
	int,
	page.Cursor,
	content.ListFilter,
) ([]content.Content, string, error) {
	return nil, "", nil
}

// contractExtensionsService mounts the extension routes without a package
// directory or a plugin host: the contract test only inspects the route set.
type contractExtensionsService struct{}

func (contractExtensionsService) List() ([]extensions.Extension, error) {
	return nil, nil
}

func (contractExtensionsService) ImportZip(io.Reader, int64) (extensions.Extension, error) {
	return extensions.Extension{}, nil
}

func (contractExtensionsService) SetEnabled(string, bool) (extensions.Extension, error) {
	return extensions.Extension{}, nil
}

func (contractExtensionsService) Remove(string) error { return nil }

// registeredRoutes returns the routes the router actually serves.
func registeredRoutes(engine *gin.Engine) map[routeKey]struct{} {
	routes := make(map[routeKey]struct{})
	for _, route := range engine.Routes() {
		routes[routeKey{Method: route.Method, Path: normalizeGinPath(route.Path)}] = struct{}{}
	}
	return routes
}

// documentedRoutes returns the method and path pairs the document promises.
func documentedRoutes(doc document) map[routeKey]struct{} {
	routes := make(map[routeKey]struct{})
	for path, operations := range doc.Paths {
		for method, op := range operations {
			routes[routeKey{
				Method: strings.ToUpper(method),
				Path:   fullPath(path, op),
			}] = struct{}{}
		}
	}
	return routes
}

// ginParam matches a gin path parameter, for example ":contentID".
var ginParam = regexp.MustCompile(`:([A-Za-z_][A-Za-z0-9_]*)`)

// normalizeGinPath rewrites gin's ":param" syntax into the OpenAPI "{param}" form so
// the two route sets are comparable.
func normalizeGinPath(path string) string {
	return ginParam.ReplaceAllString(path, "{$1}")
}
func formatKeys(routes map[routeKey]struct{}) []string {
	out := make([]string, 0, len(routes))
	for key := range routes {
		out = append(out, key.Method+" "+key.Path)
	}
	sort.Strings(out)
	return out
}

// operationalRoutes are served for humans and crawlers rather than being part of
// the JSON API contract. The contract documents the API under /api/v1; the embedded
// reference page is static tooling, so adding it to the YAML would pollute every
// generated client. Sitemap.xml and robots.txt are site-root files and are mounted
// only when their dependencies are wired, so they are covered by the router tests
// instead of appearing in this intentionally partial router.
var operationalRoutes = map[routeKey]struct{}{
	{Method: http.MethodGet, Path: "/api/v1/docs"}:         {},
	{Method: http.MethodGet, Path: "/api/v1/docs/app.css"}: {},
	{Method: http.MethodGet, Path: "/api/v1/docs/app.js"}:  {},
}

// TestEveryRegisteredRouteIsDocumented fails when the server exposes an endpoint the
// contract does not describe.
func TestEveryRegisteredRouteIsDocumented(t *testing.T) {
	doc := loadDocument(t)
	documented := documentedRoutes(doc)
	registered := registeredRoutes(buildRouter())

	var missing []string
	for key := range registered {
		if _, ok := documented[key]; ok {
			continue
		}
		if _, ok := operationalRoutes[key]; ok {
			continue
		}
		missing = append(missing, key.Method+" "+key.Path)
	}

	sort.Strings(missing)
	require.Empty(t, missing,
		"these routes are served but not documented in %s: %v", docPath, missing)
}

// TestEveryDocumentedRouteExists fails when the contract promises an endpoint the
// server does not serve.
func TestEveryDocumentedRouteExists(t *testing.T) {
	doc := loadDocument(t)
	documented := documentedRoutes(doc)
	registered := registeredRoutes(buildRouter())

	var extra []string
	for key := range documented {
		if _, ok := registered[key]; !ok {
			extra = append(extra, key.Method+" "+key.Path)
		}
	}

	sort.Strings(extra)
	require.Empty(t, extra,
		"these routes are documented but not implemented: %v", extra)
}

// TestEveryOperationDocumentsResponses keeps the contract from describing an endpoint
// without saying what it returns.
func TestEveryOperationDocumentsResponses(t *testing.T) {
	doc := loadDocument(t)

	valid := map[int]struct{}{
		http.StatusOK: {}, http.StatusCreated: {}, http.StatusAccepted: {},
		http.StatusNoContent: {}, http.StatusSwitchingProtocols: {},
		// 302 is the authorization code flow's answer: both third party login endpoints
		// send the browser on with a Location header instead of a body.
		http.StatusFound: {},
		// 304 is the ETag revalidation answer of `GET /sites/{siteID}/site-config`:
		// the browser keeps its copy instead of downloading the document per boot.
		http.StatusNotModified: {},
		http.StatusBadRequest:  {}, http.StatusUnauthorized: {}, http.StatusForbidden: {},
		http.StatusNotFound: {}, http.StatusConflict: {}, http.StatusUnprocessableEntity: {},
		http.StatusTooManyRequests: {}, http.StatusInternalServerError: {},
		// 502 is the OAuth callback's answer when the provider, not this server,
		// failed the code exchange or the profile request.
		http.StatusBadGateway:         {},
		http.StatusServiceUnavailable: {},
	}

	for path, operations := range doc.Paths {
		for method, op := range operations {
			require.NotEmpty(t, op.Responses, "%s %s documents no responses", method, path)
			for status := range op.Responses {
				var code int
				_, err := parseStatusCode(status, &code)
				require.NoError(t, err, "%s %s has a malformed status %q", method, path, status)
				require.Contains(t, valid, code,
					"%s %s uses an undocumented status %s", method, path, status)
			}
		}
	}
}

func parseStatusCode(raw string, out *int) (int, error) {
	code := 0
	for _, r := range raw {
		if r < '0' || r > '9' {
			return 0, errUnsupportedStatus
		}
		code = code*10 + int(r-'0')
	}
	*out = code
	return *out, nil
}

var errUnsupportedStatus = &statusError{}

type statusError struct{}

func (*statusError) Error() string { return "unsupported status code" }

// TestProblemCodeEnumMatchesImplementation is the check that keeps the documented
// error vocabulary identical to the one the server can actually produce.
func TestProblemCodeEnumMatchesImplementation(t *testing.T) {
	doc := loadDocument(t)

	problem, ok := doc.Components.Schemas["Problem"]
	require.True(t, ok, "Problem schema is missing")

	codeProperty, ok := problem.Properties["code"]
	require.True(t, ok, "Problem.code is missing")
	require.NotEmpty(t, codeProperty.Enum)

	documented := make([]string, len(codeProperty.Enum))
	copy(documented, codeProperty.Enum)
	sort.Strings(documented)

	implemented := make([]string, 0, len(apperr.AllCodes()))
	for _, code := range apperr.AllCodes() {
		implemented = append(implemented, string(code))
	}

	require.Equal(t, implemented, documented,
		"the documented error codes must match the implemented ones exactly")
}

// TestErrorResponsesUseProblemJSON verifies the media type a client must expect.
func TestErrorResponsesUseProblemJSON(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRoot(t), docPath))
	require.NoError(t, err)

	text := string(raw)
	require.Contains(t, text, "application/problem+json")
	require.Contains(t, text, "bearerAuth")
}
