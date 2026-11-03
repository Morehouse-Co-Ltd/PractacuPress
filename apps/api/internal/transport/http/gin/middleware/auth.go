package middleware

import (
	"context"
	"errors"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// AccessTokenVerifier validates an access token and returns its principal.
//
// It is an interface so the HTTP layer depends on verification only, not on the
// issuer's key material.
type AccessTokenVerifier interface {
	VerifyAccess(raw string) (auth.Principal, error)
}

// MembershipResolver loads the caller's live membership of one site.
//
// A token is a snapshot: the role and the membership status it was minted with stay
// true for its whole lifetime, while the database may already have demoted, suspended
// or removed the account. Every site-scoped authorization decision therefore re-reads
// the membership, and the token only proves "this account was here". Leaving this out
// would let a revoked administrator keep publishing until the access token expires.
type MembershipResolver interface {
	// Membership returns the active membership of userID in siteID.
	// A non-active or missing membership is reported as an error.
	Membership(ctx context.Context, siteID, userID string) (site.Member, error)
}

// membershipResolver picks the first non-nil resolver so callers can pass an optional
// dependency without branching at every construction site.
func membershipResolver(resolvers []MembershipResolver) MembershipResolver {
	for _, resolver := range resolvers {
		if resolver != nil {
			return resolver
		}
	}
	return nil
}

// livePrincipal replaces the token's role claim with the database role. It reports
// whether the caller still has an active membership; a database failure counts as
// "not a member", which is the safe direction for an authorization check.
func livePrincipal(c *gin.Context, resolver MembershipResolver, principal auth.Principal) (auth.Principal, bool) {
	member, err := resolver.Membership(c.Request.Context(), principal.SiteID, principal.UserID)
	if err != nil {
		return auth.Principal{}, false
	}
	principal.Role = member.Role
	return principal, true
}

// RequireAuth rejects requests without a valid bearer access token.
//
// Every rejection is 401 with the stable unauthenticated code; the specific reason
// is a detail field so a client can distinguish "log in again" from "bad header"
// without parsing prose.
func RequireAuth(verifier AccessTokenVerifier) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw, ok := bearerToken(c.GetHeader("Authorization"))
		if !ok {
			abortUnauthenticated(c, "missing_bearer_token")
			return
		}

		principal, err := verifier.VerifyAccess(raw)
		if err != nil {
			abortUnauthenticated(c, reasonFor(err))
			return
		}

		withPrincipal(c, principal)
		c.Next()
	}
}

// OptionalAuth attaches a principal when a valid bearer token is present and lets the
// request continue anonymously otherwise.
//
// Reading a public site must work without a session, but a reader who does present a
// token still gets their own view (their drafts, their role). A malformed or expired
// token is treated as anonymous rather than as an error, so a stale tab can still read
// public pages.
//
// A token minted for another site is dropped for the same reason a bad one is: it
// describes a different tenant. Keeping it would let an account registered on site A
// browse site B with A's identity, and every anonymous-read handler keys its queries
// off the principal's site, so the reader would silently be served the wrong site.
//
// The optional membership resolver additionally drops a token whose account is no
// longer an active member of the resolved site, so suspended or removed readers fall
// back to the anonymous view immediately instead of keeping their old role.
func OptionalAuth(verifier AccessTokenVerifier, memberships ...MembershipResolver) gin.HandlerFunc {
	resolver := membershipResolver(memberships)
	return func(c *gin.Context) {
		raw, ok := bearerToken(c.GetHeader("Authorization"))
		if ok && verifier != nil {
			if principal, err := verifier.VerifyAccess(raw); err == nil && siteMatches(c, principal) {
				if resolver == nil {
					withPrincipal(c, principal)
				} else if live, active := livePrincipal(c, resolver, principal); active {
					withPrincipal(c, live)
				}
			}
		}
		c.Next()
	}
}

// siteMatches reports whether the token's site is the site this request resolved to.
//
// When no site resolved there is nothing to disagree with: a deployment without a host
// resolver addresses one fixed site, so the token cannot select another one.
func siteMatches(c *gin.Context, principal auth.Principal) bool {
	resolved, ok := SiteFrom(c)
	if !ok {
		return true
	}
	return principal.SiteID == resolved.ID
}

// RequireAuthForSite verifies the bearer token and binds it to the site this request
// resolves to.
//
// A token is minted for exactly one site; the hostname decides which site a request
// addresses. Comparing the two is what stops a token from tenant A from being used
// against tenant B's hostname, where the same account may hold a different role - or
// no membership at all. It is the composed form of RequireAuth + RequireSiteMatch and
// exists so the route groups can keep taking a single guard handler.
//
// The optional membership resolver replaces the token's role with the live database
// role and rejects the request outright when the membership is no longer active. That
// is what makes a demotion, suspension or removal effective immediately rather than
// when the access token expires.
func RequireAuthForSite(verifier AccessTokenVerifier, memberships ...MembershipResolver) gin.HandlerFunc {
	resolver := membershipResolver(memberships)
	return func(c *gin.Context) {
		raw, ok := bearerToken(c.GetHeader("Authorization"))
		if !ok {
			abortUnauthenticated(c, "missing_bearer_token")
			return
		}

		principal, err := verifier.VerifyAccess(raw)
		if err != nil {
			abortUnauthenticated(c, reasonFor(err))
			return
		}

		withPrincipal(c, principal)
		if !rejectForeignSite(c, principal) {
			return
		}
		if resolver != nil {
			live, active := livePrincipal(c, resolver, principal)
			if !active {
				abortUnauthenticated(c, "membership_inactive")
				return
			}
			withPrincipal(c, live)
		}
		c.Next()
	}
}

// RequireSiteMatch rejects a principal whose token was issued for another site.
//
// This is the check that stops a token minted on site A from acting on site B when
// the site is selected by hostname.
func RequireSiteMatch() gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, ok := PrincipalFrom(c)
		if !ok {
			abortUnauthenticated(c, "missing_principal")
			return
		}
		if !rejectForeignSite(c, principal) {
			return
		}

		c.Next()
	}
}

// rejectForeignSite compares the token's site with the resolved site.
//
// It reports false after writing the rejection, so callers can return immediately.
func rejectForeignSite(c *gin.Context, principal auth.Principal) bool {
	if siteMatches(c, principal) {
		return true
	}
	// "cross_site" is the reason string every module handler already uses for this
	// class of failure; the guard now rejects before the handler so clients see one
	// vocabulary regardless of which layer caught it.
	AbortProblem(c, apperr.PermissionDenied().
		WithDetail("reason", "cross_site").
		WithRequestID(RequestIDFrom(c)))
	return false
}

// RequireRole rejects principals whose role is below the required authority.
func RequireRole(minimum site.Role) gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, ok := PrincipalFrom(c)
		if !ok {
			abortUnauthenticated(c, "missing_principal")
			return
		}

		if !principal.AtLeast(minimum) {
			AbortProblem(c, apperr.PermissionDenied().
				WithDetail("required_role", string(minimum)).
				WithRequestID(RequestIDFrom(c)))
			return
		}

		c.Next()
	}
}

func abortUnauthenticated(c *gin.Context, reason string) {
	AbortProblem(c, apperr.Unauthenticated().
		WithDetail("reason", reason).
		WithRequestID(RequestIDFrom(c)))
}

func reasonFor(err error) string {
	switch {
	case errors.Is(err, auth.ErrTokenExpired):
		return "token_expired"
	default:
		return "token_invalid"
	}
}

// bearerToken extracts the token from an "Authorization: Bearer <token>" header.
//
// The scheme is matched case insensitively because clients differ, but the token
// itself is taken verbatim.
func bearerToken(header string) (string, bool) {
	const prefix = "bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}
	token := strings.TrimSpace(header[len(prefix):])
	if token == "" {
		return "", false
	}
	return token, true
}
