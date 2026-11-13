package auth_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// The handler tests drive the real gin stack (real service, real state store, the
// real error middleware) and fake only the three edges that would otherwise need a
// provider, a database and a cookie jar. Every case is about what the browser is
// told to do next, so each assertion is either a Location header or a problem body.

// oauthHandlerTrace records the order in which a callback triggers side effects.
//
// Order is the contract this file cares about most: a session must never be issued
// before the account exists, and the provider must never be called twice. A shared
// slice guarded by a mutex keeps that observable without inventing a mock
// framework.
type oauthHandlerTrace struct {
	mu    sync.Mutex
	steps []string
}

func (t *oauthHandlerTrace) record(step string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.steps = append(t.steps, step)
}

func (t *oauthHandlerTrace) recorded() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.steps...)
}

// oauthHandlerProvider is an OAuthProvider that answers with what the test set and
// records the two calls that reach the network in production.
type oauthHandlerProvider struct {
	name string

	trace *oauthHandlerTrace

	token   auth.OAuthToken
	profile auth.OAuthProfile

	exchangeErr error
	profileErr  error
}

func (p *oauthHandlerProvider) Name() string { return p.name }

func (p *oauthHandlerProvider) AuthorizeURL(state, verifier, redirectURI string) string {
	query := url.Values{
		"state":          {state},
		"code_challenge": {verifier},
		"redirect_uri":   {redirectURI},
	}
	return "https://" + p.name + ".test/authorize?" + query.Encode()
}

func (p *oauthHandlerProvider) Exchange(context.Context, string, string, string) (auth.OAuthToken, error) {
	p.trace.record("Exchange")
	if p.exchangeErr != nil {
		return auth.OAuthToken{}, p.exchangeErr
	}
	return p.token, nil
}

func (p *oauthHandlerProvider) FetchProfile(context.Context, auth.OAuthToken) (auth.OAuthProfile, error) {
	p.trace.record("FetchProfile")
	if p.profileErr != nil {
		return auth.OAuthProfile{}, p.profileErr
	}
	return p.profile, nil
}

// oauthHandlerAccounts is an OAuthAccountStore whose identity lookup already knows
// the user, so the happy path is the "returning user" branch and no account write
// happens. It still records the membership the callback asks for, because that call
// is what keeps a real login from being refused as not_a_member.
type oauthHandlerAccounts struct {
	trace  *oauthHandlerTrace
	userID string
	err    error

	// membershipSiteID is the site the handler passed to EnsureMembership; it must
	// be the site the session is bound to, not just the callback's fallback.
	membershipSiteID string
}

func (s *oauthHandlerAccounts) FindIdentity(context.Context, string, string) (string, bool, error) {
	s.trace.record("FindIdentity")
	if s.err != nil {
		return "", false, s.err
	}
	if s.userID == "" {
		return "", false, nil
	}
	return s.userID, true, nil
}

func (s *oauthHandlerAccounts) FindUserByEmail(context.Context, string) (string, bool, error) {
	s.trace.record("FindUserByEmail")
	return "", false, s.err
}

func (s *oauthHandlerAccounts) CreateUser(context.Context, string, string, string, string) (string, error) {
	s.trace.record("CreateUser")
	return "", s.err
}

func (s *oauthHandlerAccounts) EnsureMembership(_ context.Context, siteID, _ string) error {
	s.trace.record("EnsureMembership")
	s.membershipSiteID = siteID
	return s.err
}

func (s *oauthHandlerAccounts) LinkIdentity(context.Context, string, string, string, string) error {
	s.trace.record("LinkIdentity")
	return s.err
}

// oauthHandlerIssuer records the session handoff instead of writing cookies, which
// is exactly the seam the handler is supposed to depend on.
type oauthHandlerIssuer struct {
	trace *oauthHandlerTrace
	err   error

	users []string
}

func (i *oauthHandlerIssuer) IssueForUser(_ context.Context, userID string) error {
	i.trace.record("IssueForUser")
	i.users = append(i.users, userID)
	return i.err
}

// oauthHandlerFixture is the mounted router plus the fakes behind it.
type oauthHandlerFixture struct {
	engine   *gin.Engine
	provider *oauthHandlerProvider
	accounts *oauthHandlerAccounts
	issuer   *oauthHandlerIssuer
	trace    *oauthHandlerTrace
	// states is the same store the service writes to, kept so a test can mint an
	// attempt directly and cover the landing-time validation on its own.
	states *auth.MemoryOAuthStateStore
}

// oauthHandlerCallbackURI is the per-site, per-provider callback builder the
// service and the handler share; the tests only need it to be deterministic.
func oauthHandlerCallbackURI(siteID, provider string) string {
	return "https://api.test/sites/" + siteID + "/auth/oauth/" + provider + "/callback"
}

func newOAuthHandlerFixture(t *testing.T) *oauthHandlerFixture {
	t.Helper()
	gin.SetMode(gin.TestMode)

	trace := &oauthHandlerTrace{}
	provider := &oauthHandlerProvider{
		name:  "google",
		trace: trace,
		token: auth.OAuthToken{AccessToken: "access-google", TokenType: "Bearer", ExpiresIn: 3600},
		profile: auth.OAuthProfile{
			Subject:       "subject-1",
			Email:         "ada@example.com",
			EmailVerified: true,
			DisplayName:   "Ada Lovelace",
			AvatarURL:     "https://cdn.example.com/ada.png",
		},
	}
	states := auth.NewMemoryOAuthStateStore()
	service := auth.NewOAuthService(
		states,
		map[string]auth.OAuthProvider{"google": provider},
		oauthHandlerCallbackURI,
	)
	accounts := &oauthHandlerAccounts{trace: trace, userID: "user-1"}
	issuer := &oauthHandlerIssuer{trace: trace}

	handler := auth.NewOAuthHandler(auth.OAuthHandlerDeps{
		Service:  service,
		Accounts: accounts,
		Sessions: issuer,
		// No site landing page: an unspecified deployment keeps the "/" fallback,
		// which is the behaviour the redirect cases assert.
		Redirects: nil,
	})

	engine := gin.New()
	engine.Use(middleware.RequestID(), middleware.ErrorHandler(nil))
	engine.GET("/auth/oauth/:provider/start", handler.Start)
	engine.GET("/auth/oauth/:provider/callback", handler.Callback)

	return &oauthHandlerFixture{
		engine:   engine,
		provider: provider,
		accounts: accounts,
		issuer:   issuer,
		trace:    trace,
		states:   states,
	}
}

// get performs one request against the mounted router.
func (f *oauthHandlerFixture) get(t *testing.T, target string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	recorder := httptest.NewRecorder()
	f.engine.ServeHTTP(recorder, request)
	return recorder
}

// start mints a live state by calling the start endpoint, the way a browser would,
// and returns it so a callback case can redeem a real attempt. The default target
// is the one most cases expect; startWithRedirect covers the others.
func (f *oauthHandlerFixture) start(t *testing.T, siteID string) string {
	t.Helper()
	return f.startWithRedirect(t, siteID, "/dashboard")
}

// startWithRedirect starts a flow for one post-login target. An empty target
// simulates a visitor who did not ask for a specific page.
func (f *oauthHandlerFixture) startWithRedirect(t *testing.T, siteID, redirect string) string {
	t.Helper()
	target := "/auth/oauth/google/start?site_id=" + url.QueryEscape(siteID)
	if redirect != "" {
		target += "&redirect=" + url.QueryEscape(redirect)
	}
	recorder := f.get(t, target)
	require.Equal(t, http.StatusFound, recorder.Code, "start must redirect: %s", recorder.Body.String())

	location, err := url.Parse(recorder.Header().Get("Location"))
	require.NoError(t, err)
	state := location.Query().Get("state")
	require.NotEmpty(t, state, "the authorize URL must carry the minted state")
	return state
}

// callbackURL builds a provider callback for a live state.
//
// It deliberately carries no redirect parameter: the provider echoes only its own
// query, and the target must come back from the login state instead.
func callbackURL(siteID, state string) string {
	return "/auth/oauth/google/callback?site_id=" + url.QueryEscape(siteID) +
		"&code=code-1&state=" + url.QueryEscape(state)
}

// decodeProblem asserts the response is a problem+json document and returns it.
func decodeProblem(t *testing.T, recorder *httptest.ResponseRecorder) apperr.Problem {
	t.Helper()
	require.Equal(t, apperr.ContentType, recorder.Header().Get("Content-Type"),
		"errors must be reported as application/problem+json")
	var problem apperr.Problem
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &problem), "body: %s", recorder.Body.String())
	return problem
}

func TestOAuthHandlerStartRedirectsToProvider(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)

	recorder := fixture.get(t, "/auth/oauth/google/start?site_id=site-1&redirect=%2Fdashboard")
	require.Equal(t, http.StatusFound, recorder.Code, "body: %s", recorder.Body.String())

	location := recorder.Header().Get("Location")
	require.Contains(t, location, "state=", "the redirect must carry the state the callback echoes")

	parsed, err := url.Parse(location)
	require.NoError(t, err)
	require.Equal(t, "google.test", parsed.Host, "the browser must be sent to the provider")
	require.Equal(t, "https://api.test/sites/site-1/auth/oauth/google/callback", parsed.Query().Get("redirect_uri"))

	// Start touches neither the account store nor the session issuer: nothing about
	// the visitor is decided before the provider has answered.
	require.Empty(t, fixture.trace.recorded())
	require.Empty(t, recorder.Header().Values("Set-Cookie"))
}

func TestOAuthHandlerStartRejectsUnknownProvider(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)

	recorder := fixture.get(t, "/auth/oauth/wechat/start?site_id=site-1")
	require.Equal(t, http.StatusNotFound, recorder.Code, "an unoffered provider is a 4xx, not a crash")

	problem := decodeProblem(t, recorder)
	require.Equal(t, "provider_disabled", problem.Details["reason"])
	require.Empty(t, fixture.trace.recorded())
	require.Empty(t, recorder.Header().Values("Set-Cookie"))
}

func TestOAuthHandlerCallbackResolvesAccountThenIssuesSession(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)
	state := fixture.start(t, "site-1")

	// The callback carries no redirect parameter; the "/dashboard" it lands on is the
	// target Start stored in the login state, not something the provider echoed.
	recorder := fixture.get(t, callbackURL("site-1", state))
	require.Equal(t, http.StatusFound, recorder.Code, "body: %s", recorder.Body.String())
	require.Equal(t, "/dashboard", recorder.Header().Get("Location"))

	// The whole point of the seam: exchange the code, resolve the account, make it a
	// member of the login's site, and only then hand out the session.
	require.Equal(t, []string{"Exchange", "FetchProfile", "FindIdentity", "EnsureMembership", "IssueForUser"},
		fixture.trace.recorded())
	require.Equal(t, "site-1", fixture.accounts.membershipSiteID,
		"the membership must target the site the session is bound to")
	require.Equal(t, []string{"user-1"}, fixture.issuer.users)
}

func TestOAuthHandlerCallbackUsesStoredTargetOverCallbackQuery(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)
	state := fixture.startWithRedirect(t, "site-1", "/settings/connections?tab=oauth")

	// A hand-built callback can carry a redirect of its own. The state recorded at
	// Start is authoritative, so the visitor still lands on the page they asked for
	// when the flow began; the query value is ignored, not merged.
	recorder := fixture.get(t, callbackURL("site-1", state)+"&redirect="+url.QueryEscape("/somewhere-else"))
	require.Equal(t, http.StatusFound, recorder.Code, "body: %s", recorder.Body.String())
	require.Equal(t, "/settings/connections?tab=oauth", recorder.Header().Get("Location"))
}

func TestOAuthHandlerCallbackFallsBackWithoutStoredTarget(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)
	state := fixture.startWithRedirect(t, "site-1", "")

	recorder := fixture.get(t, callbackURL("site-1", state))
	require.Equal(t, http.StatusFound, recorder.Code, "body: %s", recorder.Body.String())
	require.Equal(t, "/", recorder.Header().Get("Location"),
		"without a stored target the existing site landing fallback applies")
}

func TestOAuthHandlerCallbackDropsUnsafeStoredTarget(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)

	targets := map[string]string{
		"absolute https":         "https://evil.com",
		"protocol relative":      "//evil.com/steal",
		"absolute http":          "http://evil.com/dashboard",
		"javascript url":         "javascript:alert(1)",
		"backslash confusion":    "/\\evil.com",
		"not rooted at the site": "dashboard",
	}
	for name, target := range targets {
		t.Run(name, func(t *testing.T) {
			// Start is the entry point that accepts a target, so an off-site value is
			// dropped before it is stored and the callback lands on the fallback.
			state := fixture.startWithRedirect(t, "site-1", target)
			issuedBefore := len(fixture.issuer.users)

			recorder := fixture.get(t, callbackURL("site-1", state))
			require.Equal(t, http.StatusFound, recorder.Code, "body: %s", recorder.Body.String())
			require.Equal(t, "/", recorder.Header().Get("Location"),
				"a target that leaves the site must be dropped, not followed")

			// The login itself still succeeds: only the landing page is replaced.
			require.Equal(t, issuedBefore+1, len(fixture.issuer.users))
			require.Equal(t, "user-1", fixture.issuer.users[len(fixture.issuer.users)-1])
		})
	}
}

func TestOAuthHandlerCallbackRevalidatesStoredTarget(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)

	// Start sanitises before storing, but Location must not trust the row blindly:
	// mint an attempt with an off-site target directly, as an older writer or a bad
	// migration could leave behind, and prove the landing step still drops it.
	attempt, err := auth.NewOAuthState("site-1", "google", "https://evil.com/steal", 10*time.Minute)
	require.NoError(t, err)
	require.NoError(t, fixture.states.Create(context.Background(), attempt))

	recorder := fixture.get(t, callbackURL("site-1", attempt.State))
	require.Equal(t, http.StatusFound, recorder.Code, "body: %s", recorder.Body.String())
	require.Equal(t, "/", recorder.Header().Get("Location"),
		"a stored value that is unsafe must be dropped at landing time")
}

func TestOAuthHandlerCallbackRejectsInvalidState(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)

	for name, state := range map[string]string{
		"unknown": "state-that-was-never-minted",
		"empty":   "",
	} {
		t.Run(name, func(t *testing.T) {
			recorder := fixture.get(t, callbackURL("site-1", state))
			require.Equal(t, http.StatusBadRequest, recorder.Code, "body: %s", recorder.Body.String())

			problem := decodeProblem(t, recorder)
			require.Equal(t, "invalid_state", problem.Details["reason"])

			// A state that cannot be redeemed must stop the flow before the provider,
			// the account store or the session are touched at all.
			require.Empty(t, fixture.trace.recorded())
			require.Empty(t, recorder.Header().Values("Set-Cookie"))
		})
	}
}

func TestOAuthHandlerCallbackRejectsReplayedState(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)
	state := fixture.start(t, "site-1")

	first := fixture.get(t, callbackURL("site-1", state))
	require.Equal(t, http.StatusFound, first.Code, "body: %s", first.Body.String())

	second := fixture.get(t, callbackURL("site-1", state))
	require.Equal(t, http.StatusBadRequest, second.Code, "a consumed state must not be redeemable twice")

	problem := decodeProblem(t, second)
	require.Equal(t, "invalid_state", problem.Details["reason"])
	require.Equal(t, []string{"user-1"}, fixture.issuer.users, "the replay must not issue a second session")
}

func TestOAuthHandlerCallbackMapsProviderFailuresTo502(t *testing.T) {
	cases := map[string]struct {
		configure func(*oauthHandlerProvider)
		reason    string
	}{
		"exchange": {
			configure: func(p *oauthHandlerProvider) {
				p.exchangeErr = fmt.Errorf("%w: status 500", auth.ErrOAuthExchangeFailed)
			},
			reason: "exchange_failed",
		},
		"profile": {
			configure: func(p *oauthHandlerProvider) {
				p.profileErr = fmt.Errorf("%w: status 503", auth.ErrOAuthProfileFailed)
			},
			reason: "profile_failed",
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			fixture := newOAuthHandlerFixture(t)
			state := fixture.start(t, "site-1")
			tc.configure(fixture.provider)

			recorder := fixture.get(t, callbackURL("site-1", state))
			require.Equal(t, http.StatusBadGateway, recorder.Code,
				"a provider outage is upstream, not this server's failure: %s", recorder.Body.String())

			problem := decodeProblem(t, recorder)
			require.Equal(t, tc.reason, problem.Details["reason"])

			// A provider failure happens before any account exists, so no session may
			// be issued for it.
			require.NotContains(t, fixture.trace.recorded(), "IssueForUser")
			require.Empty(t, recorder.Header().Values("Set-Cookie"))
		})
	}
}

func TestOAuthHandlerCallbackIssuerFailureWritesNoSession(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)
	state := fixture.start(t, "site-1")
	fixture.issuer.err = errors.New("session store is unavailable")

	recorder := fixture.get(t, callbackURL("site-1", state))
	require.GreaterOrEqual(t, recorder.Code, 500, "a failed session handoff is a server failure")
	require.Empty(t, recorder.Header().Values("Set-Cookie"),
		"no cookie may be written when the session could not be established")

	// The session was attempted last, after the account was resolved and joined to
	// the site.
	require.Equal(t, []string{"Exchange", "FetchProfile", "FindIdentity", "EnsureMembership", "IssueForUser"},
		fixture.trace.recorded())
}

func TestOAuthHandlerCallbackAccountFailureWritesNoSession(t *testing.T) {
	fixture := newOAuthHandlerFixture(t)
	state := fixture.start(t, "site-1")
	fixture.accounts.err = errors.New("database is unavailable")

	recorder := fixture.get(t, callbackURL("site-1", state))
	require.GreaterOrEqual(t, recorder.Code, 500)
	require.Empty(t, recorder.Header().Values("Set-Cookie"))
	require.NotContains(t, fixture.trace.recorded(), "IssueForUser",
		"an account that could not be resolved must not get a session")
}
