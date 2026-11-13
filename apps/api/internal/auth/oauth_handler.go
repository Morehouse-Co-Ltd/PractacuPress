package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// Third party login over HTTP (FSD F-04).
//
// This file is only the transport half of the flow. OAuthService mints and redeems
// the login attempt against the provider, ResolveOAuthAccount decides which local
// account the profile belongs to, and the browser session is handed out by an
// injected issuer. Nothing here loads a database row and nothing here writes a
// cookie, so the three steps can be tested in isolation and the ordering between
// them (exchange, resolve, issue) stays visible in one place.
//
// The rule this file owns is the trajectory of the browser: where Start sends it,
// and where Callback brings it back. Both are 302s, because the browser is the
// client of an authorization code flow; a JSON body would be useless to it. Only
// failures answer problem+json, which is what the SPA's error handling expects.

// OAuthSessionIssuer hands out a browser session for an authenticated user.
//
// It is an interface rather than a call on Handler because the cookie layout, the
// CSRF derivation and the refresh-token lifetime all belong to the session
// machinery; a third party login must produce exactly the same session as a
// password login, and duplicating that logic here is how the two would drift.
//
// IssueForUser returns an error when no session could be established. The handler
// writes nothing else on success: the response is a redirect, and the cookie (if
// the deployment uses one) has already been set by the implementation.
type OAuthSessionIssuer interface {
	IssueForUser(ctx context.Context, userID string) error
}

// OAuthHandlerDeps is everything the third party login endpoints need.
type OAuthHandlerDeps struct {
	// Service starts and finishes the provider conversation. Required.
	Service *OAuthService
	// Accounts resolves a provider profile to a local user. Required.
	Accounts OAuthAccountStore
	// Sessions issues the session for the resolved user. Required.
	Sessions OAuthSessionIssuer
	// Redirects resolves the landing page of a site, so a completed login can return
	// the visitor to the site they started from rather than to the API host. It is
	// optional: an empty answer means "fall back to /", which is the API's own root.
	Redirects func(siteID string) string
	// SiteID resolves the site a request belongs to, which is the site the session
	// will be bound to and therefore the site the resolved account must be a member
	// of. It is optional: without it the callback's site_id is used, which is the
	// site the login state was minted for (Finish has already verified the two
	// agree). The deployment wires it to the same resolution the OAuth routes and
	// the session binding use, so a first login cannot land on one site while the
	// session is minted for another.
	SiteID func(c *gin.Context) string
}

// OAuthHandler exposes the third party login endpoints over HTTP.
type OAuthHandler struct {
	service   *OAuthService
	accounts  OAuthAccountStore
	sessions  OAuthSessionIssuer
	redirects func(siteID string) string
	siteID    func(c *gin.Context) string
}

// NewOAuthHandler builds a handler from its dependencies.
//
// The dependencies are stored as given rather than defaulted: a missing Service,
// Accounts or Sessions is a wiring bug, and reporting it as a 500 at request time
// is more honest than silently answering a login flow nobody can complete.
func NewOAuthHandler(deps OAuthHandlerDeps) *OAuthHandler {
	return &OAuthHandler{
		service:   deps.Service,
		accounts:  deps.Accounts,
		sessions:  deps.Sessions,
		redirects: deps.Redirects,
		siteID:    deps.SiteID,
	}
}

// Start sends the browser to the provider's authorization page.
//
// The provider comes from the path so the URL reads like the API it belongs to
// (/auth/oauth/google/start). The site and the post-login target come from the
// query: the site decides which callback URI is registered with the provider, and
// the target is only ever an in-site path, checked here and again at the callback.
// A target that is not a plain path ("https://evil.com", "//evil.com", a
// javascript: URL) is dropped instead of rejected: the visitor still gets to sign
// in, they simply land on the site root afterwards.
func (h *OAuthHandler) Start(c *gin.Context) {
	if h.service == nil {
		_ = c.Error(apperr.Internal(errors.New("auth: oauth start: handler has no service")))
		return
	}

	provider := c.Param("provider")
	siteID := strings.TrimSpace(c.Query("site_id"))
	redirectTarget := sanitizeOAuthRedirect(c.Query("redirect"))

	authURL, err := h.service.Start(c.Request.Context(), siteID, provider, redirectTarget)
	if err != nil {
		_ = c.Error(oauthStartProblem(err))
		return
	}

	// 302 rather than 303: the browser must issue a GET at the provider, which is
	// what 302 already does for a GET request and what every OAuth client expects.
	c.Redirect(http.StatusFound, authURL)
}

// Callback redeems the provider's answer and signs the visitor in.
//
// The steps are ordered and each one gates the next:
//
//  1. Finish consumes the state, exchanges the code for a profile and hands back
//     the post-login target stored at Start. A replayed, expired or foreign state
//     stops here, before any account or session exists.
//  2. ResolveOAuthAccount maps the profile to a local user, creating or linking one
//     as the product's rules require, and makes sure that account is a member of
//     this site. That last part is not optional: the session below is bound to the
//     site, so an account without a membership would be refused as not_a_member —
//     which is exactly what a first provider login on a fresh site must not be.
//  3. Sessions.IssueForUser hands out the session. It runs last on purpose: a
//     failure in either of the first two steps must not leave the browser holding a
//     cookie for a login the server did not complete.
func (h *OAuthHandler) Callback(c *gin.Context) {
	if h.service == nil || h.accounts == nil || h.sessions == nil {
		_ = c.Error(apperr.Internal(errors.New("auth: oauth callback: handler dependencies are incomplete")))
		return
	}

	provider := c.Param("provider")
	siteID := strings.TrimSpace(c.Query("site_id"))
	code := c.Query("code")
	state := c.Query("state")

	// A provider that answers with an error instead of a code (the user pressed
	// "deny", the application was revoked) is a refusal, not a server failure. It is
	// reported as a validation problem so the UI can show the provider's wording
	// instead of a generic 500.
	if providerReason := strings.TrimSpace(c.Query("error")); providerReason != "" && code == "" {
		_ = c.Error(apperr.Validation("provider_error").
			WithDetail("provider_reason", providerReason).
			WithMessage("第三方登录被拒绝或已取消，请重试。"))
		return
	}
	// An empty state can never be redeemed: OAuthService refuses it as unknown, so
	// answering 400 here saves a store round trip and keeps the reason explicit.
	if state == "" {
		_ = c.Error(apperr.Validation("invalid_state"))
		return
	}
	if code == "" {
		_ = c.Error(apperr.Validation("missing_code"))
		return
	}

	profile, redirectTarget, err := h.service.Finish(c.Request.Context(), siteID, provider, code, state)
	if err != nil {
		_ = c.Error(oauthCallbackProblem(err))
		return
	}

	userID, outcome, err := ResolveOAuthAccount(c.Request.Context(), h.accounts, h.accountSiteID(c, siteID), provider, profile)
	if err != nil {
		// The account decision failed — including a site that has closed
		// registration, which mapError reports as 403 registration_closed: no session
		// may be issued and the original error stays as the cause for the log, never
		// on the wire.
		_ = c.Error(mapError(err))
		return
	}

	if err := h.sessions.IssueForUser(c.Request.Context(), userID); err != nil {
		// outcome is recorded in the cause so an operator can tell a first login from
		// a returning one when the session write is what broke.
		_ = c.Error(mapError(fmt.Errorf("auth: issue oauth session for user %q (outcome %q): %w", userID, outcome, err)))
		return
	}

	c.Redirect(http.StatusFound, h.landingURL(siteID, redirectTarget))
}

// accountSiteID is the site the resolved account and its membership belong to.
//
// It must be the site the session is minted for, which is the site the request was
// resolved to (see ginrouter.OAuthSessionBinding), not the one named in the
// callback query: the two normally agree, but when they do not the session is what
// authorises, so the account has to follow it. The callback's site_id is the
// fallback for a deployment that wires no resolver; it is the site the login state
// was minted for, which Finish has already checked against the state.
func (h *OAuthHandler) accountSiteID(c *gin.Context, callbackSiteID string) string {
	if h.siteID != nil {
		if resolved := strings.TrimSpace(h.siteID(c)); resolved != "" {
			return resolved
		}
	}
	return callbackSiteID
}

// landingURL resolves where the browser lands after a successful login.
//
// requested is the target Finish read back from the login state: the callback
// itself carries no redirect parameter of ours, so this is what the visitor asked
// for at Start. It is re-validated by the same sanitizeOAuthRedirect rule before
// it reaches Location, so even a state row that somehow holds an unsafe value can
// only ever move the browser inside the site it already trusts. When no target
// survives, the site's own landing page is used, and when the deployment
// configured no landing page either, the fallback is "/".
func (h *OAuthHandler) landingURL(siteID, requested string) string {
	target := sanitizeOAuthRedirect(requested)

	base := ""
	if h.redirects != nil {
		base = strings.TrimRight(strings.TrimSpace(h.redirects(siteID)), "/")
	}

	switch {
	case target != "" && base != "":
		return base + target
	case target != "":
		return target
	case base != "":
		return base + "/"
	default:
		return "/"
	}
}

// sanitizeOAuthRedirect returns raw when it is a safe in-site path, and "" when it
// is not.
//
// "Safe" means: a rooted path with no scheme, no host and no userinfo, so it can
// only address this site. Absolute URLs (https://evil.com), protocol relative URLs
// (//evil.com/path, which the browser turns into https://evil.com/path), and inputs
// carrying characters that browsers or proxies normalise differently (backslash,
// CR/LF) are all refused. A refused value is not an error: the caller ignores it
// and keeps the request, which is what a stale "?redirect=" from an old link needs.
func sanitizeOAuthRedirect(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.ContainsAny(raw, "\r\n\\") {
		return ""
	}

	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	// A scheme ("https:", "javascript:", "data:") or a host makes the value leave
	// this site; userinfo ("//user:pass@host") hides a host behind an @ sign.
	if parsed.Scheme != "" || parsed.Host != "" || parsed.User != nil {
		return ""
	}
	// Only a rooted path can be appended to an origin unambiguously.
	if !strings.HasPrefix(parsed.Path, "/") {
		return ""
	}
	// "//host/path" parses with an empty path part in some forms and a doubled
	// slash in others; both are protocol relative to a browser.
	if strings.HasPrefix(parsed.Path, "//") {
		return ""
	}
	return raw
}

// oauthStartProblem maps a Start failure onto the API error model.
//
// A provider this site does not offer is a 404: the endpoint exists, the provider
// behind it does not, and the client should hide the button rather than retry. The
// reason detail says which sentinel fired, because "not found" alone would be
// indistinguishable from a typo in the path.
func oauthStartProblem(err error) *apperr.Problem {
	switch {
	case errors.Is(err, ErrOAuthProviderDisabled):
		return apperr.NotFound("oauth_provider").
			WithDetail("reason", "provider_disabled").
			WithMessage("该登录方式当前不可用。").
			WithCause(err)
	case errors.Is(err, ErrOAuthStateInvalid):
		// Start mints its own state, so this only happens when the store refuses the
		// record (a duplicate, or a context that was already cancelled).
		return apperr.Validation("invalid_state").
			WithMessage("登录状态无效，请重试。").
			WithCause(err)
	}
	return mapError(err)
}

// oauthCallbackProblem maps a Callback failure onto the API error model.
//
// The distinction the client needs is: "your login attempt is no longer usable"
// (400, retry the flow), "the provider is not available here" (400, hide the
// button) and "the provider failed us" (502, retry later). Everything else is a
// server failure and goes through mapError, which keeps the cause for logs only.
func oauthCallbackProblem(err error) *apperr.Problem {
	switch {
	case errors.Is(err, ErrOAuthStateInvalid):
		return apperr.Validation("invalid_state").
			WithMessage("登录状态无效或已过期，请重新登录。").
			WithCause(err)
	case errors.Is(err, ErrOAuthProviderDisabled):
		return apperr.Validation("provider_disabled").
			WithMessage("该登录方式当前不可用。").
			WithCause(err)
	case errors.Is(err, ErrOAuthExchangeFailed):
		return oauthUpstreamProblem("exchange_failed", err)
	case errors.Is(err, ErrOAuthProfileFailed):
		return oauthUpstreamProblem("profile_failed", err)
	}
	return mapError(err)
}

// oauthUpstreamProblem reports a provider side failure as 502 Bad Gateway.
//
// apperr is the only package allowed to choose a status, and its fixed table has
// no upstream entry yet: every 5xx code there means "this server broke". A provider
// outage is not that, and answering 500 would make an operator look at the wrong
// system, so this one case sets the status explicitly. The code stays "internal"
// because no other code describes it; the reason detail carries the sentinel. When
// the error table grows an upstream code this function collapses into apperr.New.
func oauthUpstreamProblem(reason string, err error) *apperr.Problem {
	problem := apperr.New(apperr.CodeInternal)
	problem.Status = http.StatusBadGateway
	return problem.
		WithDetail("reason", reason).
		WithMessage("第三方登录服务暂不可用，请稍后重试。").
		WithCause(err)
}
