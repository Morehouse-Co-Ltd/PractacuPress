package main

// Third party login (FSD F-04) at the composition root.
//
// The endpoints themselves are transport code and the provider conversations belong
// to the auth package. What is assembled here is the three pieces that need something
// only the process has: the state table (raw SQL, because oauth_states has no ent
// entity), the account store (the same ent store login already uses) and the session
// issuer, which must leave the browser holding exactly the cookies a password login
// leaves.
//
// The whole feature is optional: without provider credentials buildOAuth answers nil,
// main mounts nothing and the process behaves exactly as it did before.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/fieldcrypto"
	ginrouter "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin"
)

// oauthSiteLookupTimeout bounds the domain lookup that builds a callback URI when no
// PUBLIC_BASE_URL is configured. It runs inside a login request, so a slow database
// has to fail that login instead of holding the visitor's browser.
const oauthSiteLookupTimeout = 2 * time.Second

// oauthProviderIDs are the providers this server implements. The configuration also
// allows wechat, which has no implementation yet, so it is deliberately absent: a
// registered provider that only answers "disabled" at the provider would be worse
// than one the API does not offer.
var oauthProviderIDs = []string{"google", "github"}

// buildOAuth wires third party login, or returns nil when no provider is configured.
//
// A provider is registered only when its client id and secret are both present
// (config rejects a half configured registration at startup). If none of the
// implemented providers is configured the whole feature is off, which the caller
// expresses by leaving the dependency nil.
func buildOAuth(
	cfg config.Config,
	logger *slog.Logger,
	handle *db.DB,
	authService *auth.Service,
	fieldCipher *fieldcrypto.Cipher,
) *auth.OAuthHandler {
	providers := make(map[string]auth.OAuthProvider, len(oauthProviderIDs))
	for _, id := range oauthProviderIDs {
		registration := cfg.AuthOAuth[id]
		if !registration.Configured() {
			continue
		}
		provider, err := newOAuthProvider(id, registration)
		if err != nil {
			// The rest of the API does not depend on third party login, so a provider
			// that cannot be built is reported and left out instead of failing startup.
			logger.Warn("third party login provider is unusable", "provider", id, "error", err)
			continue
		}
		providers[id] = provider
	}
	if len(providers) == 0 {
		logger.Info("third party login is not configured")
		return nil
	}

	names := make([]string, 0, len(providers))
	for id := range providers {
		names = append(names, id)
	}
	sort.Strings(names)
	logger.Info("third party login configured", "providers", strings.Join(names, ","))

	base := oauthSiteBase(cfg, sitestore.New(handle.Client, sitestore.WithFieldCipher(fieldCipher)))

	return auth.NewOAuthHandler(auth.OAuthHandlerDeps{
		Service: auth.NewOAuthService(
			authstore.NewOAuthStateStore(handle),
			providers,
			oauthRedirectURI(cfg, base),
		),
		Accounts: authstore.New(handle.Client, authstore.WithFieldCipher(fieldCipher)),
		Sessions: oauthSessionIssuer{sessions: authService},
		// A completed login returns the visitor to the site they started on.
		Redirects: base,
	})
}

// newOAuthProvider builds the provider for one registration.
func newOAuthProvider(id string, registration config.OAuthProviderConfig) (auth.OAuthProvider, error) {
	switch id {
	case "google":
		return auth.NewGoogleOAuth(registration.ClientID, registration.ClientSecret, auth.OAuthEndpoints{}, nil)
	case "github":
		return auth.NewGithubOAuth(registration.ClientID, registration.ClientSecret, auth.OAuthEndpoints{}, nil)
	default:
		return nil, fmt.Errorf("no implementation for provider %q", id)
	}
}

// oauthSiteBase returns the public origin of the site a login belongs to.
//
// PUBLIC_BASE_URL wins when it is set: it is the one origin an operator can pin, and
// it is what a reverse proxy deployment needs, because the request host may be an
// internal name. That is also why an http desktop or localhost install has to set it
// explicitly: the fallback below assumes https, which is what a public site needs but
// what a loopback install cannot serve. Without it the site's own domain is used,
// which is the host the browser is actually on. The builder cannot report an error —
// the service calls it in the middle of a flow — so an unresolvable site answers ""
// and the provider rejects the callback URI; the startup warning in main is the
// operator's clue.
func oauthSiteBase(cfg config.Config, sites *sitestore.Store) func(siteID string) string {
	if base := strings.TrimRight(strings.TrimSpace(cfg.PublicBaseURL), "/"); base != "" {
		return func(string) string { return base }
	}

	return func(siteID string) string {
		siteID = strings.TrimSpace(siteID)
		if siteID == "" {
			return ""
		}
		ctx, cancel := context.WithTimeout(context.Background(), oauthSiteLookupTimeout)
		defer cancel()

		found, err := sites.FindByID(ctx, siteID)
		if err != nil || found.Domain == "" {
			return ""
		}
		return "https://" + found.Domain
	}
}

// oauthRedirectURI builds the callback URI of one provider for one site.
//
// An explicit redirect URI in the provider registration wins: it is the exact string
// registered in the provider's console, and a flow that names anything else is
// refused by the provider. Otherwise the URI is the site's public origin plus the
// route the router actually mounts.
//
// site_id travels in the query because that is the only value the provider echoes
// back: the callback reads it to decide which site the login belongs to, and the
// state it redeems must name the same site or the login is refused. The same builder
// is used when the browser is sent to the provider and when the code is exchanged,
// which is what makes the two agree.
func oauthRedirectURI(cfg config.Config, base func(siteID string) string) func(siteID, provider string) string {
	return func(siteID, provider string) string {
		if registration, ok := cfg.AuthOAuth[provider]; ok {
			if exact := strings.TrimSpace(registration.RedirectURI); exact != "" {
				return exact
			}
		}
		origin := base(siteID)
		if origin == "" {
			return ""
		}
		callback := origin + "/api/v1/auth/oauth/" + url.PathEscape(provider) + "/callback"
		if siteID = strings.TrimSpace(siteID); siteID != "" {
			callback += "?site_id=" + url.QueryEscape(siteID)
		}
		return callback
	}
}

// oauthSessionIssuer finishes a third party login by handing the resolved account the
// same session a password login hands out.
//
// The auth.OAuthSessionIssuer interface only receives a context.Context, so the
// request facts — the resolved site, the client metadata and the writer that sets the
// cookies — arrive in the binding the OAuth routes install (see
// ginrouter.OAuthSessionBinding). The session itself is minted by
// auth.Service.IssueSwitchSession, the same "mint a session for this account" call
// the platform console uses, and the cookies are written by the auth handler, so a
// provider login and a password login cannot drift apart.
type oauthSessionIssuer struct {
	sessions *auth.Service
}

// IssueForUser implements auth.OAuthSessionIssuer.
func (i oauthSessionIssuer) IssueForUser(ctx context.Context, userID string) error {
	binding, ok := ginrouter.OAuthSessionFrom(ctx)
	if !ok {
		return errors.New("oauth session: request carries no session binding")
	}
	if binding.SiteID == "" {
		return errors.New("oauth session: no site resolved for the login")
	}
	if binding.WriteSession == nil {
		return errors.New("oauth session: no session cookie writer is wired")
	}
	if i.sessions == nil {
		return errors.New("oauth session: no auth service is wired")
	}

	session, err := i.sessions.IssueSwitchSession(ctx, binding.SiteID, userID, binding.Client)
	if err != nil {
		return fmt.Errorf("oauth session: issue session for user %q: %w", userID, err)
	}
	binding.WriteSession(session)
	return nil
}
