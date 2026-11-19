package auth

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"testing"
	"time"
)

// The service tests are in-process: the state store is the memory one and the
// provider is a recording fake, so every case checks what the service decided
// without reaching a network or a database.

// oauthAuthorizeCall is one recorded AuthorizeURL invocation.
type oauthAuthorizeCall struct {
	State       string
	Verifier    string
	RedirectURI string
}

// oauthExchangeCall is one recorded Exchange invocation.
type oauthExchangeCall struct {
	Code        string
	Verifier    string
	RedirectURI string
}

// recordingOAuthProvider is an OAuthProvider that remembers what it was asked to
// do and answers with whatever the test configured.
type recordingOAuthProvider struct {
	name           string
	authorizeCalls []oauthAuthorizeCall
	exchangeCalls  []oauthExchangeCall
	profileCalls   []OAuthToken

	token       OAuthToken
	profile     OAuthProfile
	exchangeErr error
	profileErr  error
}

// newRecordingOAuthProvider returns a fake with a token and profile already set.
func newRecordingOAuthProvider(name string) *recordingOAuthProvider {
	return &recordingOAuthProvider{
		name:  name,
		token: OAuthToken{AccessToken: "access-" + name, TokenType: "Bearer", ExpiresIn: 3600},
		profile: OAuthProfile{
			Subject:       "subject-" + name,
			Email:         "ada@example.com",
			EmailVerified: true,
			DisplayName:   "Ada Lovelace",
			AvatarURL:     "https://cdn.example.com/ada.png",
			Raw:           map[string]any{"sub": "subject-" + name},
		},
	}
}

func (p *recordingOAuthProvider) Name() string { return p.name }

func (p *recordingOAuthProvider) AuthorizeURL(state, verifier, redirectURI string) string {
	p.authorizeCalls = append(p.authorizeCalls, oauthAuthorizeCall{
		State:       state,
		Verifier:    verifier,
		RedirectURI: redirectURI,
	})
	query := url.Values{
		"state":         {state},
		"code_verifier": {verifier},
		"redirect_uri":  {redirectURI},
	}
	return "https://" + p.name + ".test/authorize?" + query.Encode()
}

func (p *recordingOAuthProvider) Exchange(_ context.Context, code, verifier, redirectURI string) (OAuthToken, error) {
	p.exchangeCalls = append(p.exchangeCalls, oauthExchangeCall{
		Code:        code,
		Verifier:    verifier,
		RedirectURI: redirectURI,
	})
	if p.exchangeErr != nil {
		return OAuthToken{}, p.exchangeErr
	}
	return p.token, nil
}

func (p *recordingOAuthProvider) FetchProfile(_ context.Context, token OAuthToken) (OAuthProfile, error) {
	p.profileCalls = append(p.profileCalls, token)
	if p.profileErr != nil {
		return OAuthProfile{}, p.profileErr
	}
	return p.profile, nil
}

// testOAuthRedirectURI is the per-site, per-provider callback builder under test.
func testOAuthRedirectURI(siteID, provider string) string {
	return "https://api.test/sites/" + siteID + "/oauth/" + provider + "/callback"
}

// newOAuthServiceFixture builds a service with one registered "google" provider.
func newOAuthServiceFixture(t *testing.T) (*OAuthService, *MemoryOAuthStateStore, *recordingOAuthProvider) {
	t.Helper()
	store := NewMemoryOAuthStateStore()
	provider := newRecordingOAuthProvider("google")
	svc := NewOAuthService(store, map[string]OAuthProvider{"google": provider}, testOAuthRedirectURI)
	return svc, store, provider
}

// authorizeURLQuery parses a URL the fake provider built and returns its query.
func authorizeURLQuery(t *testing.T, raw string) url.Values {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("authorize URL %q does not parse: %v", raw, err)
	}
	return parsed.Query()
}

// startTestOAuthFlow runs Start and returns the URL plus the state it minted.
func startTestOAuthFlow(t *testing.T, svc *OAuthService, provider *recordingOAuthProvider, siteID, redirectTarget string) (authURL, state string) {
	t.Helper()
	authURL, err := svc.Start(context.Background(), siteID, provider.name, redirectTarget)
	if err != nil {
		t.Fatalf("Start(%q, %q) returned error: %v", siteID, provider.name, err)
	}
	if authURL == "" {
		t.Fatal("Start returned an empty authorize URL")
	}
	if len(provider.authorizeCalls) == 0 {
		t.Fatal("Start did not call AuthorizeURL")
	}
	return authURL, provider.authorizeCalls[len(provider.authorizeCalls)-1].State
}

func TestOAuthServiceStartReturnsURLAndStoresState(t *testing.T) {
	svc, store, provider := newOAuthServiceFixture(t)
	ctx := context.Background()
	before := time.Now()
	authURL, err := svc.Start(ctx, "site-1", "google", "/settings/connections")
	after := time.Now()
	if err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	if authURL == "" {
		t.Fatal("Start returned an empty authorize URL")
	}

	if len(provider.authorizeCalls) != 1 {
		t.Fatalf("AuthorizeURL calls = %d, want 1", len(provider.authorizeCalls))
	}
	call := provider.authorizeCalls[0]
	if call.State == "" {
		t.Fatal("AuthorizeURL received an empty state")
	}
	if call.Verifier == "" {
		t.Fatal("AuthorizeURL received an empty PKCE verifier")
	}
	if call.RedirectURI != testOAuthRedirectURI("site-1", "google") {
		t.Fatalf("AuthorizeURL redirect URI = %q, want %q", call.RedirectURI, testOAuthRedirectURI("site-1", "google"))
	}

	// The URL the caller gets must carry the minted state, not some other value.
	query := authorizeURLQuery(t, authURL)
	if got := query.Get("state"); got != call.State {
		t.Fatalf("authorize URL state = %q, want %q", got, call.State)
	}
	if got := query.Get("code_verifier"); got != call.Verifier {
		t.Fatalf("authorize URL verifier = %q, want %q", got, call.Verifier)
	}
	if got := query.Get("redirect_uri"); got != testOAuthRedirectURI("site-1", "google") {
		t.Fatalf("authorize URL redirect URI = %q, want %q", got, testOAuthRedirectURI("site-1", "google"))
	}

	// The attempt must be in the store, keyed by the state the URL carries.
	if got := store.Len(); got != 1 {
		t.Fatalf("Len after Start = %d, want 1", got)
	}
	stored, err := store.Consume(ctx, call.State)
	if err != nil {
		t.Fatalf("Consume(state from Start) returned error: %v", err)
	}
	if stored.State != call.State || stored.SiteID != "site-1" || stored.Provider != "google" ||
		stored.RedirectTarget != "/settings/connections" {
		t.Fatalf("stored attempt = %+v, want site/provider/target of the Start call", stored)
	}
	if stored.CodeVerifier != call.Verifier {
		t.Fatalf("stored verifier = %q, want the verifier the URL carried (%q)", stored.CodeVerifier, call.Verifier)
	}
	if stored.CreatedAt.Before(before) || stored.CreatedAt.After(after) {
		t.Fatalf("CreatedAt = %v, want within [%v, %v]", stored.CreatedAt, before, after)
	}
	if got := stored.ExpiresAt.Sub(stored.CreatedAt); got != oauthAttemptTTL {
		t.Fatalf("attempt lifetime = %v, want %v", got, oauthAttemptTTL)
	}
	if want := 10 * time.Minute; oauthAttemptTTL != want {
		t.Fatalf("oauthAttemptTTL = %v, want %v", oauthAttemptTTL, want)
	}
}

func TestOAuthServiceStartRejectsUnregisteredProvider(t *testing.T) {
	svc, store, provider := newOAuthServiceFixture(t)
	authURL, err := svc.Start(context.Background(), "site-1", "github", "/settings/connections")
	if !errors.Is(err, ErrOAuthProviderDisabled) {
		t.Fatalf("Start(unregistered provider) error = %v, want ErrOAuthProviderDisabled", err)
	}
	if authURL != "" {
		t.Fatalf("Start(unregistered provider) returned URL %q, want empty", authURL)
	}
	if got := store.Len(); got != 0 {
		t.Fatalf("Len after refused Start = %d, want 0", got)
	}
	if len(provider.authorizeCalls) != 0 {
		t.Fatalf("AuthorizeURL calls = %d, want 0", len(provider.authorizeCalls))
	}
}

func TestOAuthServiceFinishExchangesWithStoredVerifier(t *testing.T) {
	svc, _, provider := newOAuthServiceFixture(t)
	ctx := context.Background()
	authURL, state := startTestOAuthFlow(t, svc, provider, "site-1", "/settings/connections")
	verifier := provider.authorizeCalls[0].Verifier
	if got := authorizeURLQuery(t, authURL).Get("state"); got != state {
		t.Fatalf("authorize URL state = %q, want %q", got, state)
	}

	profile, redirectTarget, err := svc.Finish(ctx, "site-1", "google", "auth-code-1", state)
	if err != nil {
		t.Fatalf("Finish returned error: %v", err)
	}
	if !reflect.DeepEqual(profile, provider.profile) {
		t.Fatalf("Finish returned %+v, want the provider profile %+v", profile, provider.profile)
	}
	// The target recorded at Start is the only thing the callback can use to return
	// the visitor to where they came from; it must survive the redemption intact.
	if redirectTarget != "/settings/connections" {
		t.Fatalf("Finish redirect target = %q, want the target stored at Start", redirectTarget)
	}

	if len(provider.exchangeCalls) != 1 {
		t.Fatalf("Exchange calls = %d, want 1", len(provider.exchangeCalls))
	}
	exchange := provider.exchangeCalls[0]
	if exchange.Code != "auth-code-1" {
		t.Fatalf("Exchange code = %q, want %q", exchange.Code, "auth-code-1")
	}
	if exchange.Verifier != verifier {
		t.Fatalf("Exchange verifier = %q, want the verifier stored at Start (%q)", exchange.Verifier, verifier)
	}
	if exchange.RedirectURI != testOAuthRedirectURI("site-1", "google") {
		t.Fatalf("Exchange redirect URI = %q, want %q", exchange.RedirectURI, testOAuthRedirectURI("site-1", "google"))
	}

	if len(provider.profileCalls) != 1 {
		t.Fatalf("FetchProfile calls = %d, want 1", len(provider.profileCalls))
	}
	if got := provider.profileCalls[0]; got.AccessToken != provider.token.AccessToken {
		t.Fatalf("FetchProfile token = %+v, want the exchanged token %+v", got, provider.token)
	}
}

func TestOAuthServiceFinishRejectsReplayedState(t *testing.T) {
	svc, _, provider := newOAuthServiceFixture(t)
	ctx := context.Background()
	_, state := startTestOAuthFlow(t, svc, provider, "site-1", "/settings/connections")

	if _, _, err := svc.Finish(ctx, "site-1", "google", "auth-code-1", state); err != nil {
		t.Fatalf("first Finish returned error: %v", err)
	}
	profile, redirectTarget, err := svc.Finish(ctx, "site-1", "google", "auth-code-2", state)
	if !errors.Is(err, ErrOAuthStateInvalid) {
		t.Fatalf("second Finish error = %v, want ErrOAuthStateInvalid", err)
	}
	if !reflect.DeepEqual(profile, OAuthProfile{}) {
		t.Fatalf("second Finish returned %+v, want a zero profile", profile)
	}
	if redirectTarget != "" {
		t.Fatalf("second Finish redirect target = %q, want empty after a rejected state", redirectTarget)
	}
	if len(provider.exchangeCalls) != 1 {
		t.Fatalf("Exchange calls = %d, want 1: a replayed callback must not reach the provider", len(provider.exchangeCalls))
	}
}

func TestOAuthServiceFinishRejectsMismatchedSiteOrProvider(t *testing.T) {
	cases := []struct {
		name     string
		siteID   string
		provider string
	}{
		{name: "other site", siteID: "site-2", provider: "google"},
		{name: "other provider", siteID: "site-1", provider: "github"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			store := NewMemoryOAuthStateStore()
			google := newRecordingOAuthProvider("google")
			github := newRecordingOAuthProvider("github")
			svc := NewOAuthService(store, map[string]OAuthProvider{
				"google": google,
				"github": github,
			}, testOAuthRedirectURI)

			attempt, err := NewOAuthState("site-1", "google", "/settings/connections", oauthAttemptTTL)
			if err != nil {
				t.Fatalf("NewOAuthState returned error: %v", err)
			}
			if err := store.Create(ctx, attempt); err != nil {
				t.Fatalf("Create returned error: %v", err)
			}

			profile, redirectTarget, err := svc.Finish(ctx, tc.siteID, tc.provider, "auth-code-1", attempt.State)
			if !errors.Is(err, ErrOAuthStateInvalid) {
				t.Fatalf("Finish(%q, %q) error = %v, want ErrOAuthStateInvalid", tc.siteID, tc.provider, err)
			}
			if !reflect.DeepEqual(profile, OAuthProfile{}) {
				t.Fatalf("Finish returned %+v, want a zero profile", profile)
			}
			if redirectTarget != "" {
				t.Fatalf("Finish redirect target = %q, want empty for a mismatched attempt", redirectTarget)
			}
			if len(google.exchangeCalls) != 0 || len(github.exchangeCalls) != 0 {
				t.Fatalf("Exchange calls = %d/%d, want 0/0", len(google.exchangeCalls), len(github.exchangeCalls))
			}
		})
	}
}

func TestOAuthServiceFinishRejectsUnknownState(t *testing.T) {
	svc, _, provider := newOAuthServiceFixture(t)
	profile, redirectTarget, err := svc.Finish(context.Background(), "site-1", "google", "auth-code-1", "state-never-issued")
	if !errors.Is(err, ErrOAuthStateInvalid) {
		t.Fatalf("Finish(unknown state) error = %v, want ErrOAuthStateInvalid", err)
	}
	if !reflect.DeepEqual(profile, OAuthProfile{}) {
		t.Fatalf("Finish(unknown state) returned %+v, want a zero profile", profile)
	}
	if redirectTarget != "" {
		t.Fatalf("Finish(unknown state) redirect target = %q, want empty", redirectTarget)
	}
	if len(provider.exchangeCalls) != 0 {
		t.Fatalf("Exchange calls = %d, want 0", len(provider.exchangeCalls))
	}
}

func TestOAuthServiceFinishPropagatesExchangeFailure(t *testing.T) {
	svc, _, provider := newOAuthServiceFixture(t)
	provider.exchangeErr = fmt.Errorf("%w: provider refused the code", ErrOAuthExchangeFailed)
	_, state := startTestOAuthFlow(t, svc, provider, "site-1", "/settings/connections")

	profile, redirectTarget, err := svc.Finish(context.Background(), "site-1", "google", "auth-code-1", state)
	if !errors.Is(err, ErrOAuthExchangeFailed) {
		t.Fatalf("Finish error = %v, want ErrOAuthExchangeFailed", err)
	}
	if !reflect.DeepEqual(profile, OAuthProfile{}) {
		t.Fatalf("Finish returned %+v, want a zero profile", profile)
	}
	if redirectTarget != "" {
		t.Fatalf("Finish redirect target = %q, want empty after a failed exchange", redirectTarget)
	}
	if len(provider.exchangeCalls) != 1 {
		t.Fatalf("Exchange calls = %d, want 1", len(provider.exchangeCalls))
	}
	if len(provider.profileCalls) != 0 {
		t.Fatalf("FetchProfile calls = %d, want 0 after a failed exchange", len(provider.profileCalls))
	}
}
