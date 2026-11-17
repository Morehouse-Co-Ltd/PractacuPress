// Package preview mints and verifies the short lived links that let a reviewer open an
// unpublished draft without a session (Beta 1.2 contract H).
//
// A preview link is a bearer credential: whoever holds the URL can read the draft until
// the token expires. The token therefore carries only what is needed to prove it is
// genuine - a version marker, the content id it is scoped to, and an expiry instant -
// and a keyed MAC over those three fields. No session, no role and no site is embedded:
// the reader's ordinary access rules still apply, so a preview never escalates a
// password protected or members-only item.
package preview

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Token layout and defaults.
const (
	// tokenVersion prefixes every token so a future format change can be recognized
	// instead of silently accepted.
	tokenVersion = "v1"
	// KeyFileName is the HMAC key file inside the data directory. It sits next to the
	// data it protects, like the field encryption key: it keeps tokens from being
	// forged by someone who merely knows the URL layout, and it survives a restart so
	// a link handed out before a deploy keeps working.
	KeyFileName = "preview.key"
	// KeySize is the HMAC key length in bytes.
	KeySize = 32
	// DefaultTTL is the lifetime a caller gets when it does not ask for one.
	DefaultTTL = 30 * time.Minute
)

// Errors reported by the signer.
var (
	// ErrInvalidKey means the supplied key is too short to be a real secret.
	ErrInvalidKey = errors.New("preview: invalid signing key")
	// ErrEmptyContent means a token was requested without a usable content id.
	ErrEmptyContent = errors.New("preview: empty content id")
)

// Signer mints and verifies preview tokens.
//
// It is safe for concurrent use: the key and clock are read only after construction.
type Signer struct {
	key []byte
	now func() time.Time
}

// Options configures a Signer.
type Options struct {
	// Key is the HMAC secret. LoadOrCreateKey / New populate it from the data
	// directory; a test may supply its own.
	Key []byte
	// Now is the clock; nil falls back to time.Now. Tests use it to cross the expiry.
	Now func() time.Time
}

// New builds a Signer from options.
func New(options Options) (*Signer, error) {
	if len(options.Key) < KeySize {
		return nil, ErrInvalidKey
	}
	key := make([]byte, len(options.Key))
	copy(key, options.Key)

	now := options.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Signer{key: key, now: now}, nil
}

// Open loads (or creates) the signing key under dataDir and returns a Signer.
//
// This is the constructor the server uses: <dataDir>/preview.key is generated with 0600
// permissions on first start and read back afterwards, so preview links survive a
// restart and never depend on an environment secret.
func Open(dataDir string) (*Signer, error) {
	dir := strings.TrimSpace(dataDir)
	if dir == "" {
		return nil, fmt.Errorf("preview: data directory is required")
	}
	key, err := LoadOrCreateKey(filepath.Join(dir, KeyFileName))
	if err != nil {
		return nil, err
	}
	return New(Options{Key: key})
}

// LoadOrCreateKey reads the base64 key at path, generating a random one with 0600
// permissions when the file does not exist yet.
func LoadOrCreateKey(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err == nil {
		key, decodeErr := decodeKey(string(raw))
		if decodeErr != nil {
			return nil, decodeErr
		}
		return key, nil
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("preview: read key file: %w", err)
	}

	key := make([]byte, KeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("preview: generate key: %w", err)
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("preview: create key directory: %w", err)
		}
	}
	encoded := base64.StdEncoding.EncodeToString(key) + "\n"
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		return nil, fmt.Errorf("preview: write key file: %w", err)
	}
	return key, nil
}

// decodeKey parses the stored base64 key.
func decodeKey(raw string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil || len(key) < KeySize {
		// A corrupt key file must not be silently replaced: every outstanding preview
		// link would change meaning without an operator noticing.
		return nil, fmt.Errorf("preview: key file is malformed")
	}
	return key, nil
}

// Issue mints a token for one content id.
//
// The returned expiry is the exact instant Verify accepts up to; a caller echoes it in
// the API response so the client can count down without decoding the token.
func (s *Signer) Issue(contentID string, ttl time.Duration) (string, time.Time, error) {
	contentID = strings.TrimSpace(contentID)
	if contentID == "" {
		return "", time.Time{}, ErrEmptyContent
	}
	if strings.Contains(contentID, ".") {
		// The token is dot separated, so a dot inside the id would make it ambiguous.
		// Content ids are UUIDs; refusing early keeps the parser unambiguous.
		return "", time.Time{}, ErrEmptyContent
	}
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	expiresAt := s.now().Add(ttl).UTC().Truncate(time.Second)
	exp := strconv.FormatInt(expiresAt.Unix(), 10)
	payload := tokenVersion + "." + contentID + "." + exp
	return payload + "." + s.sign(payload), expiresAt, nil
}

// Verify checks a token and returns the content id it authorizes.
//
// A malformed, tampered or expired token answers (false, ""); the caller then treats
// the request as an anonymous read, which is what keeps an invalid token from
// disclosing anything.
func (s *Signer) Verify(token string) (string, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 4 {
		return "", false
	}
	version, contentID, exp, signature := parts[0], parts[1], parts[2], parts[3]
	if version != tokenVersion || contentID == "" || exp == "" || signature == "" {
		return "", false
	}

	payload := version + "." + contentID + "." + exp
	if !hmac.Equal([]byte(signature), []byte(s.sign(payload))) {
		return "", false
	}

	seconds, err := strconv.ParseInt(exp, 10, 64)
	if err != nil {
		return "", false
	}
	if !s.now().Before(time.Unix(seconds, 0).UTC()) {
		return "", false
	}
	return contentID, true
}

// sign returns the base64url MAC of one token payload.
func (s *Signer) sign(payload string) string {
	mac := hmac.New(sha256.New, s.key)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
