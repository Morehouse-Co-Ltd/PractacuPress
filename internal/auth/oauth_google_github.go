package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// Provider implementations. Both follow the same shape: build the authorize URL
// from the endpoints, exchange the code with the client credentials, then read
// whatever profile document the provider offers and flatten it into
// OAuthProfile. Nothing here talks to a fixed host: tests replace the endpoints
// with a httptest server.

// googleScope is the minimum OIDC scope set this product needs: an identity
// (openid), an address to match accounts by (email) and a display name and
// avatar (profile).
const googleScope = "openid email profile"

// githubScope asks for the profile and for the verified email list. read:user
// covers /user, user:email covers /user/emails, which is the only place GitHub
// exposes verification state.
const githubScope = "read:user user:email"

// googleOAuth is the Google OIDC provider: authorization code flow with PKCE,
// no client secret in the browser, and a single userinfo call.
type googleOAuth struct {
	oauthClientBase
}

// NewGoogleOAuth builds the Google provider. Missing client credentials are not
// an error the caller can recover from mid flow, so they surface as
// ErrOAuthProviderDisabled and the provider is simply offered everywhere it is
// not configured. A nil client gets a default one with a 10s timeout.
func NewGoogleOAuth(clientID, clientSecret string, endpoints OAuthEndpoints, client *http.Client) (OAuthProvider, error) {
	if clientID == "" || clientSecret == "" {
		return nil, ErrOAuthProviderDisabled
	}
	if client == nil {
		client = &http.Client{Timeout: oauthDefaultTimeout}
	}
	return &googleOAuth{oauthClientBase: oauthClientBase{
		clientID:     clientID,
		clientSecret: clientSecret,
		endpoints:    endpoints.withDefaults(GoogleOAuthEndpoints()),
		client:       client,
	}}, nil
}

// Name implements OAuthProvider.
func (g *googleOAuth) Name() string { return "google" }

// AuthorizeURL implements OAuthProvider. The PKCE challenge is the SHA-256 of
// the verifier, base64url encoded without padding, and the verifier itself never
// leaves the server.
func (g *googleOAuth) AuthorizeURL(state, verifier, redirectURI string) string {
	query := url.Values{
		"response_type":         {"code"},
		"client_id":             {g.clientID},
		"redirect_uri":          {redirectURI},
		"scope":                 {googleScope},
		"state":                 {state},
		"code_challenge":        {pkceChallenge(verifier)},
		"code_challenge_method": {"S256"},
	}
	return g.endpoints.AuthorizeURL + "?" + query.Encode()
}

// Exchange implements OAuthProvider.
func (g *googleOAuth) Exchange(ctx context.Context, code, verifier, redirectURI string) (OAuthToken, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"client_id":     {g.clientID},
		"client_secret": {g.clientSecret},
		"code_verifier": {verifier},
	}
	body, status, err := g.postForm(ctx, g.endpoints.TokenURL, form, "application/json")
	if err != nil {
		return OAuthToken{}, fmt.Errorf("%w: %v", ErrOAuthExchangeFailed, err)
	}
	if status < 200 || status > 299 {
		return OAuthToken{}, fmt.Errorf("%w: %s", ErrOAuthExchangeFailed, statusError("token endpoint", status, body))
	}
	var payload struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return OAuthToken{}, fmt.Errorf("%w: decode token response: %v", ErrOAuthExchangeFailed, err)
	}
	if payload.AccessToken == "" {
		return OAuthToken{}, fmt.Errorf("%w: token response has no access token", ErrOAuthExchangeFailed)
	}
	return OAuthToken{
		AccessToken: payload.AccessToken,
		TokenType:   payload.TokenType,
		ExpiresIn:   payload.ExpiresIn,
	}, nil
}

// FetchProfile implements OAuthProvider against the OIDC userinfo document.
func (g *googleOAuth) FetchProfile(ctx context.Context, token OAuthToken) (OAuthProfile, error) {
	body, status, err := g.getJSON(ctx, g.endpoints.ProfileURL, token.AccessToken, "application/json")
	if err != nil {
		return OAuthProfile{}, fmt.Errorf("%w: %v", ErrOAuthProfileFailed, err)
	}
	if status < 200 || status > 299 {
		return OAuthProfile{}, fmt.Errorf("%w: %s", ErrOAuthProfileFailed, statusError("userinfo endpoint", status, body))
	}
	var payload struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return OAuthProfile{}, fmt.Errorf("%w: decode userinfo: %v", ErrOAuthProfileFailed, err)
	}
	if payload.Sub == "" {
		return OAuthProfile{}, fmt.Errorf("%w: userinfo has no subject", ErrOAuthProfileFailed)
	}
	profile := OAuthProfile{
		Subject:       payload.Sub,
		Email:         payload.Email,
		EmailVerified: payload.EmailVerified,
		DisplayName:   payload.Name,
		AvatarURL:     payload.Picture,
		Raw:           nil,
	}
	if raw, err := decodeRawObject(body); err == nil {
		profile.Raw = raw
	}
	return profile, nil
}

// githubOAuth is the GitHub provider: plain OAuth 2.0 with a JSON token answer
// and a profile split over two endpoints.
type githubOAuth struct {
	oauthClientBase
}

// NewGithubOAuth builds the GitHub provider. See NewGoogleOAuth for the
// credential and client defaults.
func NewGithubOAuth(clientID, clientSecret string, endpoints OAuthEndpoints, client *http.Client) (OAuthProvider, error) {
	if clientID == "" || clientSecret == "" {
		return nil, ErrOAuthProviderDisabled
	}
	if client == nil {
		client = &http.Client{Timeout: oauthDefaultTimeout}
	}
	return &githubOAuth{oauthClientBase: oauthClientBase{
		clientID:     clientID,
		clientSecret: clientSecret,
		endpoints:    endpoints.withDefaults(GithubOAuthEndpoints()),
		client:       client,
	}}, nil
}

// Name implements OAuthProvider.
func (g *githubOAuth) Name() string { return "github" }

// AuthorizeURL implements OAuthProvider. GitHub's OAuth Apps do not accept PKCE,
// so the verifier is not part of the redirect; it stays in the signature because
// the flow shape is shared with the OIDC provider.
func (g *githubOAuth) AuthorizeURL(state, _ string, redirectURI string) string {
	query := url.Values{
		"response_type": {"code"},
		"client_id":     {g.clientID},
		"redirect_uri":  {redirectURI},
		"scope":         {githubScope},
		"state":         {state},
	}
	return g.endpoints.AuthorizeURL + "?" + query.Encode()
}

// Exchange implements OAuthProvider. GitHub answers form encoded by default, so
// the JSON representation has to be requested explicitly; the access token is
// then read from a JSON body like any other provider.
func (g *githubOAuth) Exchange(ctx context.Context, code, _, redirectURI string) (OAuthToken, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"client_id":     {g.clientID},
		"client_secret": {g.clientSecret},
	}
	body, status, err := g.postForm(ctx, g.endpoints.TokenURL, form, "application/json")
	if err != nil {
		return OAuthToken{}, fmt.Errorf("%w: %v", ErrOAuthExchangeFailed, err)
	}
	if status < 200 || status > 299 {
		return OAuthToken{}, fmt.Errorf("%w: %s", ErrOAuthExchangeFailed, statusError("token endpoint", status, body))
	}
	var payload struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return OAuthToken{}, fmt.Errorf("%w: decode token response: %v", ErrOAuthExchangeFailed, err)
	}
	if payload.AccessToken == "" {
		detail := payload.Error
		if detail == "" {
			detail = "token response has no access token"
		}
		return OAuthToken{}, fmt.Errorf("%w: %s", ErrOAuthExchangeFailed, detail)
	}
	return OAuthToken{
		AccessToken: payload.AccessToken,
		TokenType:   payload.TokenType,
		ExpiresIn:   payload.ExpiresIn,
	}, nil
}

// FetchProfile implements OAuthProvider: /user for the identity, /user/emails
// for an address the provider has actually verified.
//
// /user only exposes the public profile address, which users routinely leave
// empty, so the verified address from /user/emails is authoritative. When no
// verified address exists the profile keeps EmailVerified false and falls back to
// the primary or public address: linking an account on an unverified address
// would let anyone claim it.
func (g *githubOAuth) FetchProfile(ctx context.Context, token OAuthToken) (OAuthProfile, error) {
	body, status, err := g.getJSON(ctx, g.endpoints.ProfileURL, token.AccessToken, "application/vnd.github+json")
	if err != nil {
		return OAuthProfile{}, fmt.Errorf("%w: %v", ErrOAuthProfileFailed, err)
	}
	if status < 200 || status > 299 {
		return OAuthProfile{}, fmt.Errorf("%w: %s", ErrOAuthProfileFailed, statusError("user endpoint", status, body))
	}
	var user struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := json.Unmarshal(body, &user); err != nil {
		return OAuthProfile{}, fmt.Errorf("%w: decode user: %v", ErrOAuthProfileFailed, err)
	}
	subject := user.Login
	if user.ID != 0 {
		subject = strconv.FormatInt(user.ID, 10)
	}
	if subject == "" {
		return OAuthProfile{}, fmt.Errorf("%w: user has no identity", ErrOAuthProfileFailed)
	}
	profile := OAuthProfile{
		Subject:     subject,
		Email:       user.Email,
		DisplayName: user.Name,
		AvatarURL:   user.AvatarURL,
	}
	if raw, err := decodeRawObject(body); err == nil {
		profile.Raw = raw
	}
	g.attachVerifiedEmail(ctx, token, &profile)
	return profile, nil
}

// attachVerifiedEmail replaces the profile address with the GitHub verified one.
// A failure here is not fatal: the caller still gets a usable identity, just
// without a verified address to match accounts on.
func (g *githubOAuth) attachVerifiedEmail(ctx context.Context, token OAuthToken, profile *OAuthProfile) {
	if g.endpoints.EmailsURL == "" {
		return
	}
	body, status, err := g.getJSON(ctx, g.endpoints.EmailsURL, token.AccessToken, "application/vnd.github+json")
	if err != nil || status < 200 || status > 299 {
		return
	}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := json.Unmarshal(body, &emails); err != nil {
		return
	}
	var primaryVerified, anyVerified, primaryPlain string
	for _, email := range emails {
		if email.Email == "" {
			continue
		}
		if email.Primary {
			if primaryPlain == "" {
				primaryPlain = email.Email
			}
			if email.Verified && primaryVerified == "" {
				primaryVerified = email.Email
			}
		}
		if email.Verified && anyVerified == "" {
			anyVerified = email.Email
		}
	}
	switch {
	case primaryVerified != "":
		profile.Email, profile.EmailVerified = primaryVerified, true
	case anyVerified != "":
		profile.Email, profile.EmailVerified = anyVerified, true
	case primaryPlain != "":
		profile.Email, profile.EmailVerified = primaryPlain, false
	}
}

// pkceChallenge derives the S256 code challenge for a verifier.
func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// decodeRawObject decodes a JSON object for OAuthProfile.Raw.
func decodeRawObject(body []byte) (map[string]any, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}
