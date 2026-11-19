package auth

import (
	"mime"
	"net"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
)

// The authentication write endpoints are the only part of the API that writes session
// cookies and can be called without a bearer token. That combination is what makes a
// cross-site request dangerous: a malicious page could log the victim into an attacker
// controlled account (login CSRF), force a logout, or turn a stolen reset link into a
// request from the victim.
//
// Two checks close that surface without breaking non-browser clients:
//
//   - Origin, when present, must match the request Host. Browsers always send it on a
//     cross-site POST, and never let a page forge it, so a mismatch is a cross-site
//     request. CLI and server-to-server callers send no Origin and are allowed through:
//     they cannot be made to attach a victim's cookie.
//   - Content-Type, when the endpoint parses a JSON body, must be application/json. A
//     cross-site "simple request" can only use text/plain, multipart/form-data or
//     application/x-www-form-urlencoded, none of which trigger a CORS preflight, so
//     requiring JSON blocks the cross-site form/fetch variants even when the browser
//     withholds Origin.
//
// Endpoints without a body (refresh, logout) accept a missing Content-Type (the SPA
// sends none) but still reject any non-JSON value that is present.

// guard returns middleware that enforces the origin and content type rules for an
// authentication write endpoint.
func (h *Handler) guard(requireJSONBody bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		if problem := validateAuthWriteRequest(c, requireJSONBody); problem != nil {
			_ = c.Error(problem)
			c.Abort()
			return
		}
		c.Next()
	}
}

// validateAuthWriteRequest applies the origin and content type rules and returns the
// problem to send, or nil when the request is acceptable.
func validateAuthWriteRequest(c *gin.Context, requireJSONBody bool) *apperr.Problem {
	if problem := validateSameOrigin(c); problem != nil {
		return problem
	}
	return validateWriteContentType(c, requireJSONBody)
}

// validateSameOrigin rejects a request whose Origin names a different host.
//
// The comparison ignores scheme and port on purpose: deployments terminate TLS and
// remap ports in front of the API, so the host is the only stable part. A missing
// Origin is allowed (non-browser client); an Origin that is present but unparsable
// (including the literal "null" sent by sandboxed contexts) is rejected.
func validateSameOrigin(c *gin.Context) *apperr.Problem {
	origin := strings.TrimSpace(c.GetHeader("Origin"))
	if origin == "" {
		return nil
	}

	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return apperr.PermissionDenied().WithDetail("reason", "origin_mismatch")
	}

	originHost := hostOnly(parsed.Host)
	requestHost := hostOnly(c.Request.Host)
	if originHost == "" || !strings.EqualFold(originHost, requestHost) {
		return apperr.PermissionDenied().WithDetail("reason", "origin_mismatch")
	}
	return nil
}

// validateWriteContentType enforces the JSON media type.
func validateWriteContentType(c *gin.Context, requireJSONBody bool) *apperr.Problem {
	header := strings.TrimSpace(c.GetHeader("Content-Type"))
	if header == "" {
		if requireJSONBody {
			return apperr.PermissionDenied().WithDetail("reason", "unsupported_content_type")
		}
		return nil
	}

	mediaType, _, err := mime.ParseMediaType(header)
	if err != nil || !strings.EqualFold(mediaType, "application/json") {
		return apperr.PermissionDenied().WithDetail("reason", "unsupported_content_type")
	}
	return nil
}

// hostOnly strips the port from a host:port pair and normalises the host.
//
// "localhost:8080" and "[::1]:8080" both reduce to their host, which is what the
// origin comparison needs when TLS is terminated and the port is remapped.
func hostOnly(hostPort string) string {
	host := hostPort
	if parsed, _, err := net.SplitHostPort(hostPort); err == nil {
		host = parsed
	}
	host = strings.TrimSpace(strings.ToLower(host))
	return strings.Trim(host, "[]")
}
