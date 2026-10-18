package middleware

import (
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
func OptionalAuth(verifier AccessTokenVerifier) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw, ok := bearerToken(c.GetHeader("Authorization"))
		if ok && verifier != nil {
			if principal, err := verifier.VerifyAccess(raw); err == nil {
				withPrincipal(c, principal)
			}
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

		resolved, ok := SiteFrom(c)
		if !ok {
			AbortProblem(c, apperr.New(apperr.CodeSiteNotFound).WithRequestID(RequestIDFrom(c)))
			return
		}

		if principal.SiteID != resolved.ID {
			AbortProblem(c, apperr.PermissionDenied().
				WithDetail("reason", "site_mismatch").
				WithRequestID(RequestIDFrom(c)))
			return
		}

		c.Next()
	}
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
