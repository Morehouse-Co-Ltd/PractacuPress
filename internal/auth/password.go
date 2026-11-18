package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// PasswordHasher hashes and verifies passwords.
//
// Password operations belong to the Rust security service in production. This
// interface exists so the domain does not care which side performs them, and so a
// development build can run without that service.
type PasswordHasher interface {
	Hash(ctx context.Context, plain string) (string, error)
	Verify(ctx context.Context, plain, encoded string) (bool, error)
}

// SecurityHasher is the subset of the security service client that hashing needs.
//
// Declaring it structurally keeps this package from importing the infrastructure
// package that implements it.
type SecurityHasher interface {
	HashPassword(ctx context.Context, plain string) (string, error)
	VerifyPassword(ctx context.Context, plain, encoded string) (bool, error)
}

// NewSecurityPasswordHasher adapts the security service client.
//
// When the service is unavailable every call fails: callers must surface a retryable
// error rather than fall back to a weaker local hash.
func NewSecurityPasswordHasher(client SecurityHasher) PasswordHasher {
	return securityPasswordHasher{client: client}
}

type securityPasswordHasher struct{ client SecurityHasher }

func (h securityPasswordHasher) Hash(ctx context.Context, plain string) (string, error) {
	return h.client.HashPassword(ctx, plain)
}

func (h securityPasswordHasher) Verify(ctx context.Context, plain, encoded string) (bool, error) {
	return h.client.VerifyPassword(ctx, plain, encoded)
}

// Argon2Params are the Argon2id cost parameters.
type Argon2Params struct {
	// Memory is the working memory in KiB.
	Memory uint32
	// Iterations is the time cost.
	Iterations uint32
	// Parallelism is the lane count.
	Parallelism uint8
	// SaltLength is the random salt size in bytes.
	SaltLength uint32
	// KeyLength is the derived key size in bytes.
	KeyLength uint32
}

// DefaultArgon2Params returns the development cost parameters.
//
// They follow the OWASP Argon2id baseline (64 MiB, 3 iterations, 2 lanes). The
// production values are owned by the Rust service and carry a policy version, so
// these exist only for local development and tests.
func DefaultArgon2Params() Argon2Params {
	return Argon2Params{
		Memory:      64 * 1024,
		Iterations:  3,
		Parallelism: 2,
		SaltLength:  16,
		KeyLength:   32,
	}
}

// NewArgon2idHasher builds a pure Go Argon2id hasher.
//
// It exists so development and tests do not require the Rust service. Production
// wiring must use NewSecurityPasswordHasher instead: keeping password handling in
// one place is what makes its policy auditable.
func NewArgon2idHasher(params Argon2Params) PasswordHasher {
	if params.Memory == 0 || params.Iterations == 0 || params.Parallelism == 0 ||
		params.SaltLength == 0 || params.KeyLength == 0 {
		params = DefaultArgon2Params()
	}
	return argon2idHasher{params: params}
}

type argon2idHasher struct{ params Argon2Params }

// Hash returns a PHC formatted Argon2id string.
func (h argon2idHasher) Hash(_ context.Context, plain string) (string, error) {
	salt := make([]byte, h.params.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: read salt: %w", err)
	}

	key := argon2.IDKey([]byte(plain), salt, h.params.Iterations, h.params.Memory,
		h.params.Parallelism, h.params.KeyLength)

	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		h.params.Memory, h.params.Iterations, h.params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// Verify checks a password against a PHC formatted Argon2id string.
//
// A malformed hash is reported as a mismatch rather than an error: the client must
// not learn whether the stored record was corrupt.
func (h argon2idHasher) Verify(_ context.Context, plain, encoded string) (bool, error) {
	params, salt, want, err := parseArgon2id(encoded)
	if err != nil {
		return false, nil
	}

	got := argon2.IDKey([]byte(plain), salt, params.Iterations, params.Memory,
		params.Parallelism, uint32(len(want)))

	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

func parseArgon2id(encoded string) (Argon2Params, []byte, []byte, error) {
	var params Argon2Params

	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return params, nil, nil, fmt.Errorf("auth: unsupported password hash format")
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return params, nil, nil, fmt.Errorf("auth: unsupported argon2 version")
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d",
		&params.Memory, &params.Iterations, &params.Parallelism); err != nil {
		return params, nil, nil, fmt.Errorf("auth: malformed argon2 parameters")
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return params, nil, nil, fmt.Errorf("auth: malformed salt")
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return params, nil, nil, fmt.Errorf("auth: malformed key")
	}
	if len(key) == 0 {
		return params, nil, nil, fmt.Errorf("auth: empty key")
	}

	return params, salt, key, nil
}
