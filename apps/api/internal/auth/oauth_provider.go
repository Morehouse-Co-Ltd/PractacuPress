package auth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Third party login plumbing (FSD F-04).
//
// The interface below is deliberately transport shaped: authorization URL
// building, code exchange and profile fetching are the only three things a
// provider does, and every one of them has to be observable from a test without
// reaching the real provider. Endpoints are therefore data (OAuthEndpoints) and
// the HTTP client is a constructor argument, so a fake provider is a httptest
// server plus a client pointed at it.
var (
	// ErrOAuthProviderDisabled is returned when a provider has no client
	// credentials. Callers hide the provider's button instead of starting a flow
	// that can only fail at the provider.
	ErrOAuthProviderDisabled = errors.New("auth: oauth provider is not configured")
	// ErrOAuthExchangeFailed covers every failure of the authorization code
	// exchange: transport errors, a non-2xx answer, or a body without an access
	// token. The provider's error code is kept in the message but never its
	// secrets.
	ErrOAuthExchangeFailed = errors.New("auth: oauth code exchange failed")
	// ErrOAuthProfileFailed covers every failure while reading the authenticated
	// user's profile.
	ErrOAuthProfileFailed = errors.New("auth: oauth profile request failed")
)

const (
	// oauthDefaultTimeout bounds one default client request. A login cannot hang
	// a request goroutine for longer than a user is willing to wait.
	oauthDefaultTimeout = 10 * time.Second
	// oauthMaxBodyBytes caps how much of a provider body is read. Profile payloads
	// are small; anything larger is a misconfiguration, not a bigger user.
	oauthMaxBodyBytes = 1 << 20
)

// OAuthToken is the result of a successful code exchange.
//
// ExpiresIn is in seconds because that is what both providers report; a zero
// value means the provider did not say, not "expired now".
type OAuthToken struct {
	AccessToken string
	TokenType   string
	ExpiresIn   int
}

// OAuthProfile is the part of a provider profile this product stores.
//
// Subject is the provider's stable user identifier (the OIDC `sub`, or the
// GitHub numeric account id): email addresses change hands, subjects do not.
// Raw keeps the decoded payload for audit and for provider specific claims the
// caller may want later; it is read only by contract.
type OAuthProfile struct {
	Subject       string
	Email         string
	EmailVerified bool
	DisplayName   string
	AvatarURL     string
	Raw           map[string]any
}

// OAuthEndpoints are the three provider URLs a flow touches. Google ignores
// EmailsURL; GitHub uses it because /user only exposes a public, often empty
// address. Empty fields fall back to the provider defaults, which is what
// production uses.
type OAuthEndpoints struct {
	AuthorizeURL string
	TokenURL     string
	ProfileURL   string
	EmailsURL    string
}

// OAuthProvider is one third party identity provider.
//
// AuthorizeURL, Exchange and FetchProfile are stateless: state, PKCE verifier
// and redirect URI travel with the call because they belong to one login
// attempt, not to the registration.
type OAuthProvider interface {
	// Name is the provider id the API exposes ("google", "github").
	Name() string
	// AuthorizeURL builds the browser redirect that starts the flow.
	AuthorizeURL(state, verifier, redirectURI string) string
	// Exchange trades the authorization code for an access token.
	Exchange(ctx context.Context, code, verifier, redirectURI string) (OAuthToken, error)
	// FetchProfile reads the authenticated user's profile.
	FetchProfile(ctx context.Context, token OAuthToken) (OAuthProfile, error)
}

// GoogleOAuthEndpoints returns the live Google OIDC endpoints. Google's
// authorization server doubles as the token issuer, and the userinfo endpoint
// speaks plain OIDC, so no separate emails endpoint is needed.
func GoogleOAuthEndpoints() OAuthEndpoints {
	return OAuthEndpoints{
		AuthorizeURL: "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:     "https://oauth2.googleapis.com/token",
		ProfileURL:   "https://openidconnect.googleapis.com/v1/userinfo",
	}
}

// GithubOAuthEndpoints returns the live GitHub endpoints. GitHub has no OIDC
// userinfo document, so the profile is /user plus /user/emails.
func GithubOAuthEndpoints() OAuthEndpoints {
	return OAuthEndpoints{
		AuthorizeURL: "https://github.com/login/oauth/authorize",
		TokenURL:     "https://github.com/login/oauth/access_token",
		ProfileURL:   "https://api.github.com/user",
		EmailsURL:    "https://api.github.com/user/emails",
	}
}

// withDefaults fills the fields an override left empty.
func (e OAuthEndpoints) withDefaults(defaults OAuthEndpoints) OAuthEndpoints {
	if e.AuthorizeURL == "" {
		e.AuthorizeURL = defaults.AuthorizeURL
	}
	if e.TokenURL == "" {
		e.TokenURL = defaults.TokenURL
	}
	if e.ProfileURL == "" {
		e.ProfileURL = defaults.ProfileURL
	}
	if e.EmailsURL == "" {
		e.EmailsURL = defaults.EmailsURL
	}
	return e
}

// oauthClientBase carries the parts both providers share: the registration, the
// resolved endpoints and the HTTP client.
type oauthClientBase struct {
	clientID     string
	clientSecret string
	endpoints    OAuthEndpoints
	client       *http.Client
}

// httpClient is never nil: the constructors substitute a default client.
func (b *oauthClientBase) httpClient() *http.Client {
	return b.client
}

// postForm posts a form encoded body and returns the body plus status code.
func (b *oauthClientBase) postForm(ctx context.Context, endpoint string, form url.Values, accept string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	return b.do(req)
}

// getJSON reads a provider resource with the access token as a bearer
// credential.
func (b *oauthClientBase) getJSON(ctx context.Context, endpoint, accessToken, accept string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	if accept == "" {
		accept = "application/json"
	}
	req.Header.Set("Accept", accept)
	return b.do(req)
}

// do executes one request and reads at most oauthMaxBodyBytes of the answer.
func (b *oauthClientBase) do(req *http.Request) ([]byte, int, error) {
	resp, err := b.httpClient().Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, oauthMaxBodyBytes))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

// statusError renders a failed provider answer without echoing credentials.
func statusError(kind string, status int, body []byte) error {
	detail := strings.TrimSpace(string(body))
	if len(detail) > 200 {
		detail = detail[:200]
	}
	if detail == "" {
		return fmt.Errorf("%s: status %d", kind, status)
	}
	return fmt.Errorf("%s: status %d: %s", kind, status, detail)
}
