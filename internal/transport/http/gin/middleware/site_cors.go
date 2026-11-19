package middleware

import (
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Header names and fixed answers of the per-site CORS policy.
//
// The method and header lists are the whole API vocabulary rather than the vocabulary
// of one route: a preflight is answered before routing, so a narrower list would refuse
// a call the route itself would have allowed.
const (
	headerAllowOrigin      = "Access-Control-Allow-Origin"
	headerAllowCredentials = "Access-Control-Allow-Credentials"
	headerAllowMethods     = "Access-Control-Allow-Methods"
	headerAllowHeaders     = "Access-Control-Allow-Headers"
	headerExposeHeaders    = "Access-Control-Expose-Headers"
	headerMaxAge           = "Access-Control-Max-Age"

	siteCORSAllowedMethods = "GET, POST, PATCH, PUT, DELETE, OPTIONS"
	// The header list has to cover every header the API itself accepts on a write:
	// Idempotency-Key (create/action routes), X-Visit-Session (view de-duplication) and
	// the CSRF double submit token are all sent by the browser on a cross origin write,
	// and a preflight that omits them makes the browser refuse the call before the
	// handler ever sees it.
	siteCORSAllowedHeaders = "Content-Type, Authorization, X-Request-ID, If-None-Match, " +
		"Idempotency-Key, X-Visit-Session, X-CSRF-Token"

	// siteCORSMaxAge is how long a browser may cache a preflight answer. Ten minutes
	// matches the deployment wide policy in CORS, so a site level origin and a
	// deployment level origin behave the same from the browser's point of view.
	siteCORSMaxAge = 10 * time.Minute
)

// SiteCORS applies the per-site allowed origins recorded in site configuration.
// It runs after site resolution, so it can only see an origin list that belongs
// to the hostname the request actually arrived on.
//
// The deployment wide CORS middleware cannot do this job: it is mounted on the engine,
// before host resolution, so it only ever knows CORS_ALLOWED_ORIGINS from the process
// environment. A site owner editing `domains.cors_origins` in the admin pages was
// therefore changing a value that nothing applied. This middleware is the missing
// runtime half. It is additive to the deployment policy, never a replacement: an origin
// is allowed if either layer names it.
//
// origins resolves the list for the current request; nil disables the middleware, which
// is the right wiring for a deployment that has not opted in. The callback is only
// called for cross origin requests, so a same origin page load never pays for the
// lookup.
func SiteCORS(origins func(*gin.Context) []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		requestOrigin := strings.TrimSpace(c.GetHeader("Origin"))
		if origins == nil || requestOrigin == "" {
			// Same origin navigations and non browser clients send no Origin: there is
			// nothing to negotiate, and adding headers would only invite a cache to
			// treat an ordinary response as a CORS one.
			c.Next()
			return
		}
		if sameAuthority(requestOrigin, c.Request) {
			// Browsers do send Origin for some same origin unsafe requests. Answering
			// those with CORS headers would be pointless; skipping keeps the site's own
			// pages on exactly the code path they had before this middleware existed.
			c.Next()
			return
		}

		if !originAllowed(requestOrigin, origins(c)) {
			// Not on this site's list: no CORS headers at all and no echo of the
			// origin. A simple request still reaches the handler (the browser withholds
			// the response from script), and a preflight falls through to the router,
			// which answers 404 without granting anything. Writing a wildcard, or
			// echoing the origin unconditionally, is the classic way to turn "not
			// allowed" into "allowed from anywhere".
			c.Next()
			return
		}

		header := c.Writer.Header()
		// The origin has to be echoed exactly, and only a matched one is echoed: with
		// credentials the wildcard is invalid, and reflecting an arbitrary origin would
		// hand every site the same access.
		header.Set(headerAllowOrigin, requestOrigin)
		// Vary keeps a shared cache from replaying this decision for a different
		// origin, which is the one way an echoed origin could leak to the wrong client.
		header.Add("Vary", "Origin")
		header.Set(headerAllowCredentials, "true")
		header.Set(headerAllowMethods, siteCORSAllowedMethods)
		header.Set(headerAllowHeaders, siteCORSAllowedHeaders)
		// The SPA quotes the correlation id when a cross origin call fails; without
		// this the header exists but script cannot read it.
		header.Set(headerExposeHeaders, HeaderRequestID)

		if c.Request.Method != http.MethodOptions {
			c.Next()
			return
		}

		// An OPTIONS request from an allowed origin ends here, whether it is a real
		// preflight or a bare probe: the route it asks about is site scoped, and letting
		// gin match it would run the site guards for a request that carries no body and
		// no credentials. 204 is what the browser expects for an allowed preflight.
		header.Set(headerMaxAge, strconv.Itoa(int(siteCORSMaxAge.Seconds())))
		c.AbortWithStatus(http.StatusNoContent)
	}
}

// originParts is one origin or one allow-list entry, split into the pieces a rule
// compares. Strings are compared as parsed values rather than as text, so a trailing
// slash, a different case or a default port never decides access.
type originParts struct {
	// scheme is http or https, or empty for an entry that names only a host.
	scheme string
	// host is lower case and carries no port; a leading "*." is kept when present.
	host string
	// port is the explicit port, empty when the entry relied on the scheme default.
	port string
}

// originAllowed reports whether requestOrigin matches one of the patterns a site
// allowed. The accepted forms are the ones an operator can type in the settings page:
//
//	https://press.example.com   one exact origin
//	https://*.example.com       the zone: example.com and any subdomain, https only
//	example.com                 the same host on any scheme (the page does not force a
//	                            scheme, and silently ignoring such an entry would leave
//	                            a rule the operator can see in the UI doing nothing)
//	*                           any origin
//
// Matching is done on scheme and host, plus the port when the pattern names one. It is
// never a substring match: "https://evil-example.com" must not satisfy "*.example.com".
func originAllowed(origin string, patterns []string) bool {
	request, ok := parseOrigin(origin)
	if !ok {
		return false
	}
	for _, pattern := range patterns {
		if patternMatches(request, pattern) {
			return true
		}
	}
	return false
}

// patternMatches compares one parsed request origin with one configured entry.
func patternMatches(origin originParts, pattern string) bool {
	trimmed := strings.TrimSpace(pattern)
	if trimmed == "" {
		return false
	}
	if trimmed == "*" {
		return true
	}
	rule, ok := parsePattern(trimmed)
	if !ok {
		return false
	}
	if rule.scheme != "" && rule.scheme != origin.scheme {
		return false
	}
	if !hostMatches(rule.host, origin.host) {
		return false
	}
	return rule.port == "" || rule.port == origin.port
}

// parseOrigin splits a browser supplied Origin header. Anything that is not a plain
// http(s) origin is refused: a preflight target is never a path, a query or a userinfo
// form, so accepting one would only widen what an operator's rule can match.
func parseOrigin(raw string) (originParts, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return originParts{}, false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return originParts{}, false
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return originParts{}, false
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return originParts{}, false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return originParts{}, false
	}
	return originParts{scheme: scheme, host: host, port: parsed.Port()}, true
}

// parsePattern splits one allow-list entry, with or without a scheme.
func parsePattern(raw string) (originParts, bool) {
	value := strings.TrimSpace(raw)
	if strings.Contains(value, "://") {
		// Origins are pasted with a trailing slash often enough that it must not turn
		// a matching rule into a non-matching one.
		return parseOrigin(strings.TrimSuffix(value, "/"))
	}

	host, port := splitHostPortLoose(value)
	host = strings.ToLower(host)
	if host == "" || !validPatternHost(host) {
		return originParts{}, false
	}
	return originParts{host: host, port: port}, true
}

// validPatternHost bounds a host pattern to hostname characters and at most one
// wildcard label, so a typo cannot turn into a rule that matches more than intended.
func validPatternHost(host string) bool {
	if strings.Count(host, "*") > 1 {
		return false
	}
	if strings.Contains(host, "*") && !strings.HasPrefix(host, "*.") {
		return false
	}
	for _, r := range host {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '.', r == '-', r == '*':
		default:
			// Bracketed IPv6 literals are compared by their unbracketed form, which
			// parseOrigin produces from the Origin header; only that form is matched.
			return false
		}
	}
	return true
}

// hostMatches compares a rule host with the request origin's host.
//
// A leading "*." allows any number of labels in front, including none: an operator who
// writes "https://*.example.com" means the whole zone, and leaving the apex out would
// lock the owner of example.com out of their own site. The suffix has to start at a
// label boundary, so "evil-example.com" can never match.
func hostMatches(rule, host string) bool {
	if rule == host {
		return true
	}
	if !strings.HasPrefix(rule, "*.") {
		return false
	}
	suffix := rule[1:] // ".example.com"
	return host == rule[2:] || strings.HasSuffix(host, suffix)
}

// sameAuthority reports whether origin names the same host and port as the request.
//
// The scheme is deliberately not compared. This process listens on plain HTTP and is
// normally reached through a TLS terminating proxy, so Request.TLS is nil even for
// https traffic; comparing the scheme there would classify every same origin request as
// cross origin. The authority is what decides whether a browser applies the same origin
// policy at all, and being wrong here can only add headers for an origin an operator
// already allowed.
func sameAuthority(origin string, request *http.Request) bool {
	parsed, ok := parseOrigin(origin)
	if !ok || request == nil {
		return false
	}
	host, port := splitHostPortLoose(strings.TrimSpace(request.Host))
	host = strings.Trim(host, "[]")
	if host == "" {
		return false
	}
	return strings.EqualFold(host, parsed.host) &&
		withDefaultPort(port, parsed.scheme) == withDefaultPort(parsed.port, parsed.scheme)
}

// splitHostPortLoose splits "host:port" and leaves a bare host or a bracketed IPv6
// literal untouched, because a request Host header may be either.
func splitHostPortLoose(value string) (string, string) {
	if host, port, err := net.SplitHostPort(value); err == nil {
		return host, port
	}
	return value, ""
}

// withDefaultPort fills in the scheme's default so "example.com" and "example.com:443"
// compare equal for an https origin.
func withDefaultPort(port, scheme string) string {
	if port != "" {
		return port
	}
	if scheme == "https" {
		return "443"
	}
	return "80"
}
