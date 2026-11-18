package ginrouter

// The third party login routes are the only place where the issuer handed a bare
// context.Context has to reach back into the request for the site and the cookie
// writer. These tests mount the real handler on the real router and drive one
// complete login, so the seam is covered end to end: a binding that went missing
// would fail here as a 500 instead of a login.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
)

// oauthRouteSiteResolver resolves every host to one site, the way a single site
// deployment behaves.
type oauthRouteSiteResolver struct{}

func (oauthRouteSiteResolver) Resolve(context.Context, string) (site.Site, error) {
	return site.Site{ID: "site_contract", Name: "Contract"}, nil
}

// oauthRouteProvider answers the three provider calls without a network.
type oauthRouteProvider struct {
	name string
}

func (p oauthRouteProvider) Name() string { return p.name }

func (p oauthRouteProvider) AuthorizeURL(state, _, redirectURI string) string {
	query := url.Values{"state": {state}, "redirect_uri": {redirectURI}}
	return "https://provider.test/authorize?" + query.Encode()
}

func (oauthRouteProvider) Exchange(context.Context, string, string, string) (auth.OAuthToken, error) {
	return auth.OAuthToken{AccessToken: "access-token"}, nil
}

func (oauthRouteProvider) FetchProfile(context.Context, auth.OAuthToken) (auth.OAuthProfile, error) {
	return auth.OAuthProfile{Subject: "subject-1", Email: "ada@example.com", EmailVerified: true}, nil
}

// oauthRouteAccounts already knows the user, so the login takes the returning-user
// branch and writes nothing.
type oauthRouteAccounts struct{ userID string }

func (a oauthRouteAccounts) FindIdentity(context.Context, string, string) (string, bool, error) {
	return a.userID, true, nil
}

func (oauthRouteAccounts) FindUserByEmail(context.Context, string) (string, bool, error) {
	return "", false, nil
}

func (oauthRouteAccounts) CreateUser(context.Context, string, string, string, string) (string, error) {
	return "", errors.New("unexpected account creation")
}

func (oauthRouteAccounts) EnsureMembership(context.Context, string, string) error {
	return nil
}

func (oauthRouteAccounts) LinkIdentity(context.Context, string, string, string, string) error {
	return errors.New("unexpected identity link")
}

// oauthRouteIssuer asserts that the request carried the transport binding and writes
// the session cookies through it, exactly as the production issuer does.
type oauthRouteIssuer struct {
	siteID string
	client auth.ClientMeta
	wrote  bool
}

func (i *oauthRouteIssuer) IssueForUser(ctx context.Context, userID string) error {
	binding, ok := OAuthSessionFrom(ctx)
	if !ok {
		return errors.New("no session binding on the request")
	}
	if binding.WriteSession == nil {
		return errors.New("no session cookie writer on the request")
	}
	i.siteID = binding.SiteID
	i.client = binding.Client
	binding.WriteSession(auth.Session{
		RefreshToken:     "refresh-token",
		RefreshExpiresAt: time.Now().Add(time.Hour),
		CSRFToken:        "csrf-token",
	})
	i.wrote = true
	// The user id is the account resolver's answer; the handler promised it would
	// hand a real one over.
	if userID == "" {
		return errors.New("empty user id")
	}
	return nil
}

// oauthRoute builds the router with one registered provider.
func oauthRoute(t *testing.T) (*gin.Engine, *oauthRouteIssuer) {
	t.Helper()

	service := auth.NewOAuthService(
		auth.NewMemoryOAuthStateStore(),
		map[string]auth.OAuthProvider{"google": oauthRouteProvider{name: "google"}},
		func(siteID, provider string) string {
			return "https://site.test/auth/oauth/" + provider + "/callback?site_id=" + siteID
		},
	)
	issuer := &oauthRouteIssuer{}

	engine := testRouter(t, Dependencies{
		Config:       config.Config{AppEnv: config.EnvTest},
		SiteResolver: oauthRouteSiteResolver{},
		// The real auth handler owns the cookie layout; it only needs the transport
		// settings here, because the session is minted by the issuer.
		Auth: auth.NewHandler(nil, auth.HandlerConfig{}),
		OAuth: auth.NewOAuthHandler(auth.OAuthHandlerDeps{
			Service:  service,
			Accounts: oauthRouteAccounts{userID: "user-1"},
			Sessions: issuer,
		}),
	})
	return engine, issuer
}

// getOAuth performs one anonymous request against the router.
func getOAuth(t *testing.T, engine *gin.Engine, target string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
	return recorder
}

// TestRouterOAuthLoginStartsAnonymously proves the start endpoint is reachable
// without a session and answers with the provider redirect, not a 401.
func TestRouterOAuthLoginStartsAnonymously(t *testing.T) {
	engine, _ := oauthRoute(t)

	recorder := getOAuth(t, engine, "/api/v1/auth/oauth/google/start?site_id=site_contract")

	require.Equal(t, http.StatusFound, recorder.Code)
	authorize, err := url.Parse(recorder.Header().Get("Location"))
	require.NoError(t, err)
	require.Contains(t, authorize.Host, "provider.test")
	require.Contains(t, authorize.Query().Get("redirect_uri"), "site_id=site_contract")
}

// TestRouterOAuthCallbackIssuesSessionCookies proves the callback path reaches the
// issuer with the resolved site and that the cookies it writes end up on the 302,
// which is the whole point of the binding.
func TestRouterOAuthCallbackIssuesSessionCookies(t *testing.T) {
	engine, issuer := oauthRoute(t)

	start := getOAuth(t, engine, "/api/v1/auth/oauth/google/start?site_id=site_contract")
	require.Equal(t, http.StatusFound, start.Code)

	authorize, err := url.Parse(start.Header().Get("Location"))
	require.NoError(t, err)
	state := authorize.Query().Get("state")
	require.NotEmpty(t, state)

	callback := getOAuth(t, engine, "/api/v1/auth/oauth/google/callback?site_id=site_contract&code=code-1&state="+url.QueryEscape(state))

	require.Equal(t, http.StatusFound, callback.Code, "callback body: %s", callback.Body.String())
	require.Equal(t, "/", callback.Header().Get("Location"))
	require.True(t, issuer.wrote, "the callback must reach the session issuer")
	require.Equal(t, "site_contract", issuer.siteID)
	require.NotEmpty(t, issuer.client.IPAddress)

	cookies := strings.Join(callback.Header().Values("Set-Cookie"), "\n")
	require.Contains(t, cookies, auth.RefreshCookieName+"=refresh-token")
	require.Contains(t, cookies, auth.CSRFCookieName+"=csrf-token")
}

// TestRouterOAuthRoutesAbsentWithoutHandler keeps the optional wiring honest: with no
// configured provider the paths do not exist at all.
func TestRouterOAuthRoutesAbsentWithoutHandler(t *testing.T) {
	engine := testRouter(t, Dependencies{
		Config:       config.Config{AppEnv: config.EnvTest},
		SiteResolver: oauthRouteSiteResolver{},
	})

	recorder := getOAuth(t, engine, "/api/v1/auth/oauth/google/start?site_id=site_contract")

	require.Equal(t, http.StatusNotFound, recorder.Code)
}

var _ middleware.SiteResolver = oauthRouteSiteResolver{}
