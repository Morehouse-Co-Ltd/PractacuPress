package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// Secret sealing for data that must be recoverable, unlike a password hash.
//
// A TOTP shared secret has to be replayed to the HMAC, so it cannot be hashed. It
// is therefore encrypted at rest with AES-256-GCM and only ever written in the
// sealed form below.
const (
	// sealedSecretPrefix versions the envelope so a future key rotation can tell
	// envelopes apart instead of guessing at the format.
	sealedSecretPrefix = "v1:"
	// sealedSecretAAD binds the ciphertext to this purpose. A sealed value copied
	// into another column or another product would not decrypt.
	sealedSecretAAD = "practacu-press/2fa-secret/v1"
	// secretBoxKeyInfo is the HKDF-style label used when the key is derived from
	// the JWT signing key.
	secretBoxKeyInfo = "practacu.2fa.secret.v1"
)

// errSecretSeal is the single answer for malformed, truncated or tampered
// envelopes: distinguishing them would be an oracle for a value the caller should
// never be able to probe anyway.
var errSecretSeal = errors.New("auth: sealed secret is invalid")

// secretBox encrypts and decrypts short secrets with AES-256-GCM.
//
// The key source is the deployment's Ed25519 signing seed: the auth module already
// requires that key to be configured in production
// (AUTH_JWT_ED25519_PRIVATE_KEY), and deriving a second key from it with
// HMAC-SHA256 under a purpose label means there is no extra secret to leak, rotate
// or forget. The trade-off is documented: rotating the signing key also makes
// existing TOTP enrolments undecryptable, so a rotation needs to reset them.
// Development installs without a configured key use an ephemeral seed, which is
// consistent with sessions and access tokens also dying on restart there.
type secretBox struct {
	aead cipher.AEAD
}

// newSecretBox builds a box from a 32 byte key.
func newSecretBox(key []byte) (*secretBox, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("auth: secret box key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("auth: secret box cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("auth: secret box gcm: %w", err)
	}
	return &secretBox{aead: aead}, nil
}

// deriveSecretKey turns the JWT signing seed into the sealing key.
func deriveSecretKey(seed []byte) []byte {
	mac := hmac.New(sha256.New, seed)
	mac.Write([]byte(secretBoxKeyInfo))
	return mac.Sum(nil)
}

// Seal encrypts plain and returns the versioned base64 envelope.
func (b *secretBox) Seal(plain string) (string, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("auth: secret box nonce: %w", err)
	}
	sealed := b.aead.Seal(nonce, nonce, []byte(plain), []byte(sealedSecretAAD))
	return sealedSecretPrefix + base64.StdEncoding.EncodeToString(sealed), nil
}

// Open decrypts an envelope produced by Seal.
func (b *secretBox) Open(envelope string) (string, error) {
	if !strings.HasPrefix(envelope, sealedSecretPrefix) {
		return "", errSecretSeal
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(envelope, sealedSecretPrefix))
	if err != nil {
		return "", errSecretSeal
	}
	nonceSize := b.aead.NonceSize()
	if len(raw) < nonceSize+b.aead.Overhead() {
		return "", errSecretSeal
	}
	plain, err := b.aead.Open(nil, raw[:nonceSize], raw[nonceSize:], []byte(sealedSecretAAD))
	if err != nil {
		return "", errSecretSeal
	}
	return string(plain), nil
}

// secretBox derives the sealing box from the issuer's signing key.
//
// It is a method on TokenIssuer so the key material never leaves this package and
// the composition root does not have to wire a second secret.
func (i *TokenIssuer) secretBox() (*secretBox, error) {
	return newSecretBox(deriveSecretKey(i.key.Seed()))
}
