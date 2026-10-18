// Package contract keeps the OpenAPI document and the running router in step.
//
// The document is the cross team source of truth, so drift in either direction is a
// release blocker: an undocumented route is invisible to the frontend team, and a
// documented route that does not exist is a promise the server cannot keep.
package ginrouter_test

import (
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

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/community"
	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/media"
			"github.com/practacu/practacu-press/apps/api/internal/messaging"
	"github.com/practacu/practacu-press/apps/api/internal/notifications"
	"github.com/practacu/practacu-press/apps/api/internal/outbox"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	ginrouter "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin"
)

const docPath = "packages/contracts/openapi/openapi.yaml"

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
	Summary     string              `yaml:"summary"`
	Responses   map[string]response `yaml:"responses"`
	Security    *[]any              `yaml:"security"`
	Deprecated  bool                `yaml:"deprecated"`
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
// Health endpoints sit at the root; everything else is under the versioned prefix.
func fullPath(docPathValue string) string {
	switch docPathValue {
	case "/healthz", "/readyz":
		return docPathValue
	default:
		return "/api/v1" + docPathValue
	}
}

// routeKey is one method plus one normalised path.
type routeKey struct {
	Method string
	Path   string
}

// buildRouter mounts every handler. The services are nil on purpose: mounting only
// registers routes, so no database or security service is needed to inspect them.
func buildRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)

	return ginrouter.New(ginrouter.Dependencies{
		Config:  config.Config{AppEnv: config.EnvTest},
		Auth:    auth.NewHandler(nil, auth.HandlerConfig{}),
		Sites:   site.NewHandler(nil, site.HandlerConfig{}),
		Content: content.NewHandler(nil, content.HandlerConfig{}),
		Community: community.NewHandler(nil, community.HandlerConfig{}),
		Media:   media.NewHandler(nil, media.HandlerConfig{}),
		Events:  outbox.NewEventsHandler(nil, outbox.HandlerConfig{}),
		Notifications: notifications.NewHandler(nil, notifications.HandlerConfig{}),
		Messages: messaging.NewHandler(nil, messaging.HandlerConfig{}),
	})
}

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
		for method := range operations {
			routes[routeKey{
				Method: strings.ToUpper(method),
				Path:   fullPath(path),
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

// TestEveryRegisteredRouteIsDocumented fails when the server exposes an endpoint the
// contract does not describe.
func TestEveryRegisteredRouteIsDocumented(t *testing.T) {
	doc := loadDocument(t)
	documented := documentedRoutes(doc)
	registered := registeredRoutes(buildRouter())

	var missing []string
	for key := range registered {
		if _, ok := documented[key]; !ok {
			missing = append(missing, key.Method+" "+key.Path)
		}
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
		http.StatusOK: {}, http.StatusCreated: {}, http.StatusNoContent: {},
		http.StatusBadRequest: {}, http.StatusUnauthorized: {}, http.StatusForbidden: {},
		http.StatusNotFound: {}, http.StatusConflict: {}, http.StatusUnprocessableEntity: {},
		http.StatusTooManyRequests: {}, http.StatusInternalServerError: {},
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
