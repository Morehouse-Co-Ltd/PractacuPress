package main

// The composition root has two decisions that are easy to get wrong and impossible
// to see at runtime until a login fails: which providers are switched on, and the
// exact callback URI each one is given. These tests pin both, plus the failure the
// session issuer reports instead of finishing a login without a binding.

import (
	"context"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
)

// noOAuthConfig is what an install without third party credentials looks like.
func noOAuthConfig() config.Config {
	return config.Config{AuthOAuth: map[string]config.OAuthProviderConfig{}}
}

func TestBuildOAuthDisabledWithoutProviders(t *testing.T) {
	// A nil database handle is safe here on purpose: the function must answer before
	// it touches anything, which is what keeps an unconfigured install unchanged.
	require.Nil(t, buildOAuth(noOAuthConfig(), silentLogger(), nil, nil, nil, nil))
}

func TestOAuthRedirectURICarriesSiteAndProvider(t *testing.T) {
	cfg := config.Config{PublicBaseURL: "https://api.example.com/"}
	build := oauthRedirectURI(cfg, oauthSiteBase(cfg, nil))

	got := build("site-1", "google")

	require.Equal(t, "https://api.example.com/api/v1/auth/oauth/google/callback?site_id=site-1", got)

	// The query has to survive parsing as a real value, not as an accidental suffix.
	parsed, err := url.Parse(got)
	require.NoError(t, err)
	require.Equal(t, "/api/v1/auth/oauth/google/callback", parsed.Path)
	require.Equal(t, "site-1", parsed.Query().Get("site_id"))
}

func TestOAuthRedirectURIPrefersTheRegisteredRegistration(t *testing.T) {
	cfg := config.Config{
		PublicBaseURL: "https://api.example.com",
		AuthOAuth: map[string]config.OAuthProviderConfig{
			"github": {RedirectURI: "https://login.example.com/github/callback"},
		},
	}
	build := oauthRedirectURI(cfg, oauthSiteBase(cfg, nil))

	// The provider only accepts the string its console has registered, so an
	// explicit registration must win over the derived one.
	require.Equal(t, "https://login.example.com/github/callback", build("site-1", "github"))
}

func TestOAuthRedirectURIIsEmptyWithoutAnOrigin(t *testing.T) {
	cfg := noOAuthConfig()
	build := oauthRedirectURI(cfg, func(string) string { return "" })

	// An empty answer is a configuration bug the provider reports; inventing a URI
	// would start a flow that cannot come back.
	require.Empty(t, build("site-1", "google"))
}

func TestNewOAuthProviderRefusesUnimplementedProvider(t *testing.T) {
	_, err := newOAuthProvider("wechat", config.OAuthProviderConfig{ClientID: "id", ClientSecret: "secret"})
	require.Error(t, err)
}

func TestOAuthSessionIssuerNeedsTheRequestBinding(t *testing.T) {
	// The issuer is called with the request context by the handler; without the
	// binding the OAuth routes install it must fail instead of guessing a site or
	// silently finishing a login with no cookies.
	err := oauthSessionIssuer{}.IssueForUser(context.Background(), "user-1")
	require.Error(t, err)
}
