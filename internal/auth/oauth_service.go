package auth

import (
	"context"
	"fmt"
	"time"
)

// Third party login orchestration (FSD F-04).
//
// OAuthProvider knows how to talk to one provider, OAuthStateStore knows how to
// remember one login attempt, and OAuthService is the small piece that joins
// them: it mints the attempt before the browser leaves, and it redeems the
// attempt when the callback comes back with a code.
//
// The service deliberately stops at the profile. Creating or linking an account
// and issuing a session is a separate decision that needs repository access and
// the product's account rules; keeping it out of here means a login attempt can
// be replayed in a test without a database and a half finished flow can never
// leave an account behind.

// oauthAttemptTTL is how long a login attempt stays redeemable between the
// redirect to the provider and the callback that answers it. Ten minutes covers
// a user signing in, consenting and being redirected, while keeping a leaked
// state token useful for as short a time as practical.
const oauthAttemptTTL = 10 * time.Minute

// OAuthService starts and finishes third party logins.
//
// providers is keyed by the provider id the API exposes ("google", "github"),
// so the provider named in a request is also the provider that minted the code.
// redirectURI is a function rather than a string because the callback belongs to
// a site and to a provider: it has to be derived from the site that started the
// flow, and every provider registers its own callback path
// (/auth/oauth/{provider}/callback). The same builder must be used at
// authorization time and at exchange time or the provider rejects the code.
type OAuthService struct {
	store       OAuthStateStore
	providers   map[string]OAuthProvider
	redirectURI func(siteID, provider string) string
}

// NewOAuthService builds the service.
//
// The provider map is copied, so a caller cannot reconfigure a live service by
// mutating the map it passed in. A nil entry is treated as unregistered: a
// provider without an implementation is one that cannot be offered, which is the
// same state as a provider without credentials.
func NewOAuthService(store OAuthStateStore, providers map[string]OAuthProvider, redirectURI func(siteID, provider string) string) *OAuthService {
	registered := make(map[string]OAuthProvider, len(providers))
	for name, provider := range providers {
		if provider == nil {
			continue
		}
		registered[name] = provider
	}
	return &OAuthService{
		store:       store,
		providers:   registered,
		redirectURI: redirectURI,
	}
}

// Start mints one login attempt and returns the URL to send the browser to.
//
// The state is persisted before the URL is built, so a callback can never arrive
// for a state the service has not recorded, and it is persisted with the PKCE
// verifier the URL only carries as a challenge. An unregistered provider is
// refused with ErrOAuthProviderDisabled before anything is stored: the flow can
// only fail at the provider, so the caller is better off hiding the button.
func (s *OAuthService) Start(ctx context.Context, siteID, provider, redirectTarget string) (string, error) {
	p, ok := s.providers[provider]
	if !ok {
		return "", fmt.Errorf("%w: %q", ErrOAuthProviderDisabled, provider)
	}
	attempt, err := NewOAuthState(siteID, provider, redirectTarget, oauthAttemptTTL)
	if err != nil {
		return "", err
	}
	if err := s.store.Create(ctx, attempt); err != nil {
		return "", fmt.Errorf("auth: store oauth state: %w", err)
	}
	return p.AuthorizeURL(attempt.State, attempt.CodeVerifier, s.callbackURI(siteID, provider)), nil
}

// Finish redeems the callback and returns the provider's profile together with the
// post-login target the Start call stored for this attempt.
//
// The state is consumed first, so a replayed or unknown callback is rejected
// before the code is ever exchanged. The record must also name the site and the
// provider of the callback: a state minted for one site or one provider cannot be
// spent on another, which is what stops a code from one flow being replayed into
// a different tenant. Once the record checks out, the exchange uses the stored
// PKCE verifier and the same redirect URI the authorization URL carried.
//
// The second result is the RedirectTarget the browser asked for at Start. A
// provider callback carries no query string of ours, so this stored value is the
// only way the handler can return the visitor to the page they came from; an
// empty target means Start recorded none and the caller keeps its landing page.
// The value is returned exactly as stored: the caller still validates it before
// writing it into a Location header, because a state row is not a trust boundary.
//
// Exchange and FetchProfile errors are returned unwrapped: they already carry the
// ErrOAuthExchangeFailed / ErrOAuthProfileFailed sentinels and the caller needs
// to tell a provider outage from a bad state. Nothing is created here: no
// account, no session, no token reaches the browser.
func (s *OAuthService) Finish(ctx context.Context, siteID, provider, code, state string) (OAuthProfile, string, error) {
	attempt, err := s.store.Consume(ctx, state)
	if err != nil {
		return OAuthProfile{}, "", err
	}
	if attempt.SiteID != siteID || attempt.Provider != provider {
		return OAuthProfile{}, "", ErrOAuthStateInvalid
	}
	p, ok := s.providers[provider]
	if !ok {
		return OAuthProfile{}, "", fmt.Errorf("%w: %q", ErrOAuthProviderDisabled, provider)
	}
	token, err := p.Exchange(ctx, code, attempt.CodeVerifier, s.callbackURI(siteID, provider))
	if err != nil {
		return OAuthProfile{}, "", err
	}
	profile, err := p.FetchProfile(ctx, token)
	if err != nil {
		return OAuthProfile{}, "", err
	}
	return profile, attempt.RedirectTarget, nil
}

// callbackURI resolves the redirect URI for a site and a provider. A service
// without a builder answers with the empty string rather than panicking; the
// provider will reject the flow, which is a configuration bug the exchange
// surfaces.
func (s *OAuthService) callbackURI(siteID, provider string) string {
	if s.redirectURI == nil {
		return ""
	}
	return s.redirectURI(siteID, provider)
}
