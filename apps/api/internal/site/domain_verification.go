package site

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

// The TXT challenge that proves a domain belongs to a site.
const (
	// DomainVerificationRecordPrefix is prepended to the domain to build the record
	// name an operator publishes. A leading underscore keeps it clearly separate from
	// the host's own records.
	DomainVerificationRecordPrefix = "_practacu-verify."
	// DomainVerificationRecordType is the DNS record type of the challenge.
	DomainVerificationRecordType = "TXT"
	// domainVerificationTokenBytes is 256 bits of randomness. The schema caps the
	// token at 64 characters; base64url without padding turns 32 bytes into 43.
	domainVerificationTokenBytes = 32
	// domainVerificationLookupTimeout bounds the DNS round trip of one verification
	// attempt. It keeps a slow resolver from holding the admin request open.
	domainVerificationLookupTimeout = 10 * time.Second
)

// NewDomainVerificationToken draws a fresh challenge token.
//
// The token is the only secret of the challenge: it is generated here, stored on the
// site row and published by the operator as a TXT value. crypto/rand failure is a hard
// error, because a weak or reused token would let someone else claim the domain.
func NewDomainVerificationToken() (string, error) {
	buf := make([]byte, domainVerificationTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("site: generate domain verification token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// DomainVerificationRecordName returns the DNS record name an operator publishes to
// prove ownership of domain. An empty domain has no record.
func DomainVerificationRecordName(domain string) string {
	normalized := normalizeHost(domain)
	if normalized == "" {
		return ""
	}
	return DomainVerificationRecordPrefix + normalized
}

// DomainStatus is the domain screen of the admin API: the primary domain, whether it
// has been proven, and, while it is still pending, the challenge to publish.
type DomainStatus struct {
	Domain   string
	Verified bool
	// VerificationToken is empty once the domain is verified or no domain is set.
	VerificationToken string
	RecordName        string
	RecordType        string
}

// TXTLookup resolves the TXT records of a name.
//
// It is an interface so the DNS dependency can be injected in tests; the default is
// net.DefaultResolver.
type TXTLookup interface {
	LookupTXT(ctx context.Context, name string) ([]string, error)
}

// domainStatusOf projects a stored site onto the admin API shape.
//
// The challenge token is only exposed while it is still needed: a verified domain has
// nothing left to prove, and a domain-less site has no record name.
func domainStatusOf(found Site) DomainStatus {
	status := DomainStatus{
		Domain:     found.Domain,
		Verified:   found.DomainVerified(),
		RecordType: DomainVerificationRecordType,
		RecordName: DomainVerificationRecordName(found.Domain),
	}
	if found.Domain != "" && !status.Verified {
		status.VerificationToken = found.DomainVerificationToken
	}
	return status
}

// matchesDomainChallenge reports whether any published TXT value equals token.
//
// Records are trimmed because operators often paste them with surrounding whitespace;
// an empty expected token never matches, so a corrupted row cannot accidentally verify
// a domain.
func matchesDomainChallenge(records []string, token string) bool {
	if token == "" {
		return false
	}
	for _, record := range records {
		if strings.TrimSpace(record) == token {
			return true
		}
	}
	return false
}
