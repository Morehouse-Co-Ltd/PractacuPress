package middleware

import (
	"context"
	"errors"
	"net"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

// SiteResolver maps a request hostname to a site.
//
// It is an interface so the HTTP layer does not depend on the site service or on
// Ent, and so tests can resolve hosts without a database.
type SiteResolver interface {
	Resolve(ctx context.Context, hostname string) (site.Site, error)
}

// ResolveSite resolves the request host to a site and stores it in the request
// context.
//
// Unknown, unverified and disabled sites are all refused: falling back to a
// default site would serve one site's content under another site's hostname.
func ResolveSite(trusted TrustedProxies, resolver SiteResolver) gin.HandlerFunc {
	return func(c *gin.Context) {
		host := RequestHost(c, trusted)
		if host == "" {
			problem := apperr.New(apperr.CodeSiteNotFound).
				WithDetail("reason", "missing host").
				WithRequestID(RequestIDFrom(c))
			AbortProblem(c, problem)
			return
		}

		resolved, err := resolver.Resolve(c.Request.Context(), host)
		if err != nil {
			problem := siteProblem(err, host).WithRequestID(RequestIDFrom(c))
			AbortProblem(c, problem)
			return
		}

		withSite(c, resolved)
		c.Next()
	}
}

func siteProblem(err error, host string) *apperr.Problem {
	switch {
	case errors.Is(err, site.ErrDomainUnverified):
		return apperr.New(apperr.CodeSiteDomainUnverified).WithDetail("host", host)
	case errors.Is(err, site.ErrNotFound):
		return apperr.New(apperr.CodeSiteNotFound).WithDetail("host", host)
	case errors.Is(err, site.ErrDisabled):
		return apperr.New(apperr.CodeSiteNotFound).
			WithDetail("host", host).
			WithMessage("站点已停用")
	default:
		return apperr.Internal(err)
	}
}

// RequestHost returns the hostname this request was addressed to.
//
// X-Forwarded-Host is honoured only when the direct peer is a configured trusted
// proxy; otherwise the client could pick its own site by setting the header.
func RequestHost(c *gin.Context, trusted TrustedProxies) string {
	host := c.Request.Host
	if forwarded := c.GetHeader("X-Forwarded-Host"); forwarded != "" && trusted.ContainsRemote(c.Request.RemoteAddr) {
		host = strings.TrimSpace(strings.Split(forwarded, ",")[0])
	}
	return normalizeHost(stripPort(host))
}

// stripPort removes a trailing port, including from a bracketed IPv6 literal.
func stripPort(hostport string) string {
	hostport = strings.TrimSpace(hostport)
	if host, _, err := net.SplitHostPort(hostport); err == nil {
		return host
	}
	// No port: an IPv6 literal may still be bracketed.
	if strings.HasPrefix(hostport, "[") && strings.HasSuffix(hostport, "]") {
		return hostport[1 : len(hostport)-1]
	}
	return hostport
}

func normalizeHost(host string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
}
