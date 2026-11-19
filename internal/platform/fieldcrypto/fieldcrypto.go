// Package fieldcrypto seals individual database fields.
//
// A password is hashed, never encrypted: there is nothing to recover. Some fields
// are different. A login address has to be shown back to its owner, a private
// message has to be rendered, so those values must be recoverable at rest while
// still being unreadable in a database dump. This package is the one place that
// implements that envelope.
//
// Two modes exist:
//
//   - Seal is randomised AES-256-GCM. Two seals of the same plaintext differ, which
//     is the right default for values that are only ever read by row id.
//   - SealDeterministic derives the nonce from the plaintext, so equal values seal
//     to equal ciphertext. That is what keeps equality lookups (a login by email)
//     and unique indexes working without keeping a plaintext copy. It leaks
//     equality between rows, which is the accepted trade-off and the same leak a
//     blind index would have.
//
// Every seal is bound to a purpose string (the AAD). A ciphertext copied into
// another column, another provider or another product fails to open instead of
// silently decrypting into the wrong field.
package fieldcrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// sealedPrefix versions the randomised envelope.
	sealedPrefix = "v1:"
	// deterministicPrefix versions the deterministic envelope.
	deterministicPrefix = "d1:"
	// keySize is the AES-256 key length this package accepts.
	keySize = 32
	// labelFieldKey is the derivation label used when a key is derived from a seed.
	labelFieldKey = "practacu.field.v1"
)

// ErrInvalidEnvelope is the single answer for a malformed, truncated, tampered or
// foreign ciphertext. Distinguishing the cases would tell an attacker which guess
// was closest.
var ErrInvalidEnvelope = errors.New("fieldcrypto: sealed value is invalid")

// Cipher seals and opens field values with AES-256-GCM.
type Cipher struct {
	aead   cipher.AEAD
	macKey []byte
}

// New builds a Cipher from a 32-byte key.
func New(key []byte) (*Cipher, error) {
	if len(key) != keySize {
		return nil, fmt.Errorf("fieldcrypto: key must be %d bytes, got %d", keySize, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("fieldcrypto: cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("fieldcrypto: gcm: %w", err)
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("fieldcrypto.deterministic.nonce"))
	return &Cipher{aead: aead, macKey: mac.Sum(nil)}, nil
}

// DecodeKey parses a base64 encoded 32-byte key.
//
// Both padded and raw standard encodings are accepted so an operator can paste the
// output of `openssl rand -base64 32` (padded) or a Go base64.RawStdEncoding dump.
func DecodeKey(encoded string) ([]byte, error) {
	encoded = strings.TrimSpace(encoded)
	if encoded == "" {
		return nil, errors.New("fieldcrypto: key is empty")
	}
	if raw, err := base64.StdEncoding.DecodeString(encoded); err == nil {
		if len(raw) != keySize {
			return nil, fmt.Errorf("fieldcrypto: key must decode to %d bytes, got %d", keySize, len(raw))
		}
		return raw, nil
	}
	raw, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("fieldcrypto: key is not base64: %w", err)
	}
	if len(raw) != keySize {
		return nil, fmt.Errorf("fieldcrypto: key must decode to %d bytes, got %d", keySize, len(raw))
	}
	return raw, nil
}

// FromSeed derives a key from an existing secret.
//
// It exists for the same reason the two factor secret box derives from the signing
// seed: a deployment that already has one strong secret should not need a second
// one for a development or single operator install. Production should configure
// FIELD_ENCRYPTION_KEY explicitly, because rotating the source secret would
// otherwise make every sealed field undecryptable.
func FromSeed(seed []byte, label string) (*Cipher, error) {
	if len(seed) == 0 {
		return nil, errors.New("fieldcrypto: seed is empty")
	}
	if label == "" {
		label = labelFieldKey
	}
	mac := hmac.New(sha256.New, seed)
	mac.Write([]byte(label))
	return New(mac.Sum(nil))
}

// LoadOrCreateKeyFile reads a base64 key from path, creating a random one (0600)
// when the file does not exist yet.
//
// It is a development and single operator convenience: the key sits next to the
// data it protects, so it does not defend against someone who can read the data
// directory. Production must use FIELD_ENCRYPTION_KEY.
func LoadOrCreateKeyFile(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err == nil {
		return DecodeKey(string(raw))
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("fieldcrypto: read key file: %w", err)
	}
	key := make([]byte, keySize)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("fieldcrypto: generate key: %w", err)
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("fieldcrypto: create key directory: %w", err)
		}
	}
	encoded := base64.StdEncoding.EncodeToString(key) + "\n"
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		return nil, fmt.Errorf("fieldcrypto: write key file: %w", err)
	}
	return key, nil
}

// IsSealed reports whether value carries one of this package's envelopes.
func IsSealed(value string) bool {
	return strings.HasPrefix(value, sealedPrefix) || strings.HasPrefix(value, deterministicPrefix)
}

// Seal encrypts plain with a random nonce.
func (c *Cipher) Seal(plain, purpose string) (string, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("fieldcrypto: nonce: %w", err)
	}
	return c.sealWithNonce(nonce, plain, purpose, sealedPrefix)
}

// SealDeterministic encrypts plain with a nonce derived from the purpose and the
// plaintext, so the same input always produces the same envelope.
func (c *Cipher) SealDeterministic(plain, purpose string) (string, error) {
	mac := hmac.New(sha256.New, c.macKey)
	mac.Write([]byte(purpose))
	mac.Write([]byte{0})
	mac.Write([]byte(plain))
	sum := mac.Sum(nil)
	nonce := sum[:c.aead.NonceSize()]
	return c.sealWithNonce(nonce, plain, purpose, deterministicPrefix)
}

func (c *Cipher) sealWithNonce(nonce []byte, plain, purpose, prefix string) (string, error) {
	sealed := c.aead.Seal(nil, nonce, []byte(plain), aad(purpose))
	payload := make([]byte, 0, len(nonce)+len(sealed))
	payload = append(payload, nonce...)
	payload = append(payload, sealed...)
	return prefix + base64.StdEncoding.EncodeToString(payload), nil
}

// Open decrypts an envelope produced by Seal or SealDeterministic.
func (c *Cipher) Open(envelope, purpose string) (string, error) {
	plain, _, err := c.OpenOrPlain(envelope, purpose)
	return plain, err
}

// OpenOrPlain opens a sealed envelope and passes an unsealed value through
// unchanged, reporting whether it was sealed.
//
// The pass-through is what makes a migration lazy: rows written before the field
// was encrypted keep working, and the caller can decide to rewrite them.
func (c *Cipher) OpenOrPlain(value, purpose string) (string, bool, error) {
	switch {
	case strings.HasPrefix(value, sealedPrefix):
		plain, err := c.openWithPrefix(value, sealedPrefix, purpose)
		return plain, true, err
	case strings.HasPrefix(value, deterministicPrefix):
		plain, err := c.openWithPrefix(value, deterministicPrefix, purpose)
		return plain, true, err
	default:
		return value, false, nil
	}
}

func (c *Cipher) openWithPrefix(envelope, prefix, purpose string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(envelope, prefix))
	if err != nil {
		return "", ErrInvalidEnvelope
	}
	nonceSize := c.aead.NonceSize()
	if len(raw) < nonceSize+c.aead.Overhead() {
		return "", ErrInvalidEnvelope
	}
	plain, err := c.aead.Open(nil, raw[:nonceSize], raw[nonceSize:], aad(purpose))
	if err != nil {
		return "", ErrInvalidEnvelope
	}
	return string(plain), nil
}

// aad builds the associated data for a purpose. The version is included so a future
// envelope change cannot be confused with this one.
func aad(purpose string) []byte {
	return []byte("practacu-press/field/v1\x00" + purpose)
}
