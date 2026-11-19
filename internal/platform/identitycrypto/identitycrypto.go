// Package identitycrypto seals the personal columns of a login identity.
//
// The email and phone provider subjects and their mirrored columns are the only
// place a deployment stores an address, so they are the fields a database dump
// would leak first. They are sealed deterministically: equal addresses produce
// equal ciphertext, which is what keeps the unique index and equality lookups
// working without a plaintext copy.
//
// The package exists as its own layer so the four stores that touch an identity
// (auth, site, platform directory, notifications) share one envelope and one set of
// purpose labels. A ciphertext sealed for one purpose does not open under another.
package identitycrypto

import (
	"strings"

	"github.com/practacu/practacu-press/internal/platform/fieldcrypto"
)

// Purpose labels. They are part of the associated data, so changing one is a
// breaking format change and every stored value must be re-sealed.
const (
	PurposeEmailSubject = "user-identity.subject.email"
	PurposePhoneSubject = "user-identity.subject.phone"
	PurposeEmailColumn  = "user-identity.email"
	PurposePhoneColumn  = "user-identity.phone"
)

// Codec seals and opens identity columns. A nil receiver is a no-op codec, which
// keeps the historical plaintext behaviour for tests and development installs
// without a configured key.
type Codec struct {
	cipher *fieldcrypto.Cipher
}

// New wraps a field cipher.
func New(cipher *fieldcrypto.Cipher) *Codec {
	return &Codec{cipher: cipher}
}

// Enabled reports whether values are actually sealed.
func (c *Codec) Enabled() bool { return c != nil && c.cipher != nil }

// NormalizeAddress folds the casing and whitespace the login flow already applies,
// so the same address always seals to the same envelope.
func NormalizeAddress(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// SealSubject seals a provider subject. OAuth subjects are opaque provider ids, not
// personal addresses, and are returned unchanged.
func (c *Codec) SealSubject(provider, subject string) (string, error) {
	if !c.Enabled() {
		return subject, nil
	}
	switch provider {
	case "email":
		return c.cipher.SealDeterministic(NormalizeAddress(subject), PurposeEmailSubject)
	case "phone":
		return c.cipher.SealDeterministic(strings.TrimSpace(subject), PurposePhoneSubject)
	default:
		return subject, nil
	}
}

// OpenSubject reverses SealSubject.
func (c *Codec) OpenSubject(provider, stored string) (string, error) {
	if !c.Enabled() {
		return stored, nil
	}
	switch provider {
	case "email":
		return c.cipher.Open(stored, PurposeEmailSubject)
	case "phone":
		return c.cipher.Open(stored, PurposePhoneSubject)
	default:
		return stored, nil
	}
}

// SealEmail seals the mirrored email column.
func (c *Codec) SealEmail(address string) (string, error) {
	if !c.Enabled() {
		return address, nil
	}
	return c.cipher.SealDeterministic(NormalizeAddress(address), PurposeEmailColumn)
}

// OpenEmail reverses SealEmail.
func (c *Codec) OpenEmail(stored string) (string, error) {
	if !c.Enabled() || stored == "" {
		return stored, nil
	}
	return c.cipher.Open(stored, PurposeEmailColumn)
}

// SealPhone seals the mirrored phone column.
func (c *Codec) SealPhone(phone string) (string, error) {
	if !c.Enabled() {
		return phone, nil
	}
	return c.cipher.SealDeterministic(strings.TrimSpace(phone), PurposePhoneColumn)
}

// OpenPhone reverses SealPhone.
func (c *Codec) OpenPhone(stored string) (string, error) {
	if !c.Enabled() || stored == "" {
		return stored, nil
	}
	return c.cipher.Open(stored, PurposePhoneColumn)
}

// IsSealed reports whether a stored value is already an envelope.
func IsSealed(value string) bool { return fieldcrypto.IsSealed(value) }
