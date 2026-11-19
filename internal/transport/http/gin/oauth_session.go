package ginrouter

// Third party login session handoff.
//
// auth.OAuthHandler resolves the provider profile to a user and then asks an
// auth.OAuthSessionIssuer to hand that user a browser session. The issuer built at
// the composition root only receives a context.Context, but everything a session
// needs — which site the login belongs to, the client metadata recorded on the
// session row and the writer that sets the cookies — is request state owned by this
// transport. The OAuth routes therefore install that state as a binding on the
// request context, which keeps gin out of the issuer and keeps the cookie layout
// where it already lives (auth.Handler.WriteSessionCookies).

import (
	"context"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"
)

// oauthSessionKey keys the binding on the request context. The struct type is
// unexported so no other package can collide with it.
type oauthSessionKey struct{}

// OAuthSessionBinding is what an auth.OAuthSessionIssuer needs from one request.
type OAuthSessionBinding struct {
	// SiteID is the site the login belongs to, resolved from the request host; the
	// session is bound to it and the account must be a member of it.
	SiteID string
	// Client is the user agent and address recorded on the session row, exactly as
	// a password login records them.
	Client auth.ClientMeta
	// WriteSession sets the session cookies for a freshly minted session. A nil
	// writer means the deployment mounted the OAuth routes without the auth handler,
	// which the issuer reports as an error instead of finishing a login that leaves
	// the browser without a session.
	WriteSession func(auth.Session)
}

// OAuthSessionFrom returns the binding installed by oauthSessionContext.
func OAuthSessionFrom(ctx context.Context) (OAuthSessionBinding, bool) {
	binding, ok := ctx.Value(oauthSessionKey{}).(OAuthSessionBinding)
	return binding, ok
}

// sessionCookieWriter is the one method the third party login needs from the auth
// handler. The interface keeps this package from depending on the handler's whole
// surface for a cookie write.
type sessionCookieWriter interface {
	WriteSessionCookies(c *gin.Context, session auth.Session)
}

// oauthSessionContext installs the binding for one request.
//
// The site is read from what the resolver already put on the gin context, so the
// login belongs to the same tenant the rest of the request was scoped to; the
// configured default covers a deployment that does not resolve hosts, which is the
// same fallback the password login uses.
func oauthSessionContext(defaultSiteID string, sessions sessionCookieWriter) gin.HandlerFunc {
	return func(c *gin.Context) {
		binding := OAuthSessionBinding{
			SiteID: defaultSiteID,
			Client: auth.ClientMeta{
				UserAgent: c.GetHeader("User-Agent"),
				IPAddress: c.ClientIP(),
			},
		}
		if resolved, ok := middleware.SiteFrom(c); ok && resolved.ID != "" {
			binding.SiteID = resolved.ID
		}
		if sessions != nil {
			binding.WriteSession = func(session auth.Session) {
				sessions.WriteSessionCookies(c, session)
			}
		}

		c.Request = c.Request.WithContext(
			context.WithValue(c.Request.Context(), oauthSessionKey{}, binding),
		)
		c.Next()
	}
}
