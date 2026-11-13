package site

import (
	"fmt"
	"net"
	"strings"
	"unicode"
)

// MaxDomainLength is the DNS limit for a fully qualified name, including dots.
const MaxDomainLength = 253

// NormalizeDomain validates and normalises an operator supplied primary domain.
//
// It is the exported form of the rule every endpoint that accepts a domain uses, so a
// platform site creation cannot drift from the settings screen. An empty string means
// "no domain" and is returned unchanged.
func NormalizeDomain(raw string) (string, error) { return normalizeDomain(raw) }

// normalizeDomain validates an operator supplied primary domain.
//
// An empty string is allowed and means "clear the domain"; the handler distinguishes
// it from an omitted field before calling. Anything else must be a bare hostname:
// scheme, port, path, wildcard, IP literal, whitespace and non-ASCII characters are
// rejected. Punycode labels (xn--) are accepted, which is how internationalised
// domains are configured.
//
// The result is lowercased and has one trailing dot removed, so "Press.Example.com."
// and "press.example.com" are the same site domain.
func normalizeDomain(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if strings.IndexFunc(raw, unicode.IsSpace) >= 0 {
		return "", invalidDomain("domain must not contain whitespace")
	}

	domain := strings.ToLower(strings.TrimSuffix(raw, "."))
	if domain == "" {
		return "", invalidDomain("domain is empty")
	}
	if len(domain) > MaxDomainLength {
		return "", invalidDomain("domain is too long")
	}
	if net.ParseIP(domain) != nil {
		return "", invalidDomain("domain must be a hostname, not an IP address")
	}

	labels := strings.Split(domain, ".")
	for _, label := range labels {
		switch {
		case label == "":
			return "", invalidDomain("domain must not contain empty labels")
		case len(label) > 63:
			return "", invalidDomain("each domain label must be at most 63 characters")
		case label[0] == '-' || label[len(label)-1] == '-':
			return "", invalidDomain("domain labels must not start or end with a hyphen")
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
				continue
			}
			return "", invalidDomain("domain must contain only letters, digits, hyphens and dots")
		}
	}
	return domain, nil
}

// invalidDomain reports a rejected domain as a validation failure.
func invalidDomain(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidInput, reason)
}
