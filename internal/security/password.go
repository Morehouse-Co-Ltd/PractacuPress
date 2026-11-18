package securitygo

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Password length bounds. They are enforced before hashing so an oversized
// input cannot be used to burn CPU.
//
// The bounds are counted
// in Unicode code points, not bytes.
const (
	MinPasswordLength = 8
	MaxPasswordLength = 128
)

// MaxEncodedPasswordLength is the upper bound on a stored PHC string a caller
// may submit for verification.
//
// A real Argon2id PHC string is well under 200 bytes; anything far beyond that
// is either corrupt or an attempt to make the parser do work before the length
// checks.
const MaxEncodedPasswordLength = 1024

// Argon2id PHC parameters shared with the reference implementation.
//
// The defaults follow the OWASP recommendation (64 MiB, 3 iterations, 2 lanes)
// and are kept in one place so a change is visible and can be paired with a
// policy version bump. HashPassword always emits these parameters; verification
// reads the parameters stored in the PHC string, exactly like the reference
// implementation.
const (
	argonSaltLength = 16
	argonKeyLength  = 32
)

// Errors returned by this package.
//
// They are deliberately coarse: a caller learns that something failed, never
// which component of the password check failed.
var (
	// ErrInvalidLength means the password is outside the accepted length range.
	ErrInvalidLength = errors.New("password length is out of range")
	// ErrHashFailed means hashing failed internally.
	ErrHashFailed = errors.New("password hashing failed")
	// ErrInvalidHash means the stored hash is malformed or unusable.
	ErrInvalidHash = errors.New("stored password hash is invalid")
)

// maxVerifyMemoryKiB bounds the Argon2 memory a stored PHC string may ask for.
//
// The previous sidecar hands the parsed parameters to Argon2 without a cap (the
// transport deadline limits the caller, not the blocking hash). Go cannot abort
// an allocation the same way, so a pathological hash is treated as a mismatch
// instead of asking the runtime for an unbounded buffer. 1 GiB is 16x the
// default cost, so every hash either implementation writes is well inside it.
const maxVerifyMemoryKiB = 1024 * 1024

// Argon2Params are the Argon2id cost parameters.
type Argon2Params struct {
	// MemoryKiB is the working memory in KiB.
	MemoryKiB uint32
	// Iterations is the time cost.
	Iterations uint32
	// Parallelism is the lane count.
	Parallelism uint32
}

// DefaultArgon2Params is the cost the service uses for new hashes.
//
// Kept identical to Params2::default() in the reference implementation.
var DefaultArgon2Params = Argon2Params{
	MemoryKiB:   64 * 1024,
	Iterations:  3,
	Parallelism: 2,
}

// PlaintextWithinBounds reports whether a plaintext is inside the accepted
// length range.
//
// It is exported so the transport layer can reject a request before it spends
// a hashing permit, without duplicating the bounds.
func PlaintextWithinBounds(plain string) bool {
	length := utf8.RuneCountInString(plain)
	return length >= MinPasswordLength && length <= MaxPasswordLength
}

// EncodedWithinBounds reports whether a stored PHC string is worth handing to
// the hash parser.
//
// Empty and whitespace-only values are treated as unusable rather than
// malformed so a blank record fails fast instead of reaching Argon2.
func EncodedWithinBounds(encoded string) bool {
	return strings.TrimSpace(encoded) != "" && len(encoded) <= MaxEncodedPasswordLength
}

// HashPassword hashes a password into a PHC formatted Argon2id string.
func HashPassword(plain string) (string, error) {
	return HashPasswordWithParams(plain, DefaultArgon2Params)
}

// HashPasswordWithParams hashes a password with explicit cost parameters.
//
// Tests use it to pin the encoding; production always uses HashPassword.
func HashPasswordWithParams(plain string, params Argon2Params) (string, error) {
	if !PlaintextWithinBounds(plain) {
		return "", ErrInvalidLength
	}

	salt := make([]byte, argonSaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("%w: read salt: %v", ErrHashFailed, err)
	}
	return hashWithSalt(plain, salt, params)
}

// hashWithSalt produces the PHC string for a known salt.
//
// It exists so tests can pin the exact encoding and is not part of the
// service surface.
func hashWithSalt(plain string, salt []byte, params Argon2Params) (string, error) {
	if !PlaintextWithinBounds(plain) {
		return "", ErrInvalidLength
	}
	if err := params.validateForHashing(); err != nil {
		return "", fmt.Errorf("%w: %v", ErrHashFailed, err)
	}
	if len(salt) < 8 {
		return "", fmt.Errorf("%w: salt is too short", ErrHashFailed)
	}

	key := argon2.IDKey(
		[]byte(plain),
		salt,
		params.Iterations,
		params.MemoryKiB,
		uint8(params.Parallelism),
		argonKeyLength,
	)

	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		params.MemoryKiB, params.Iterations, params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword checks a password against a stored PHC string.
//
// The errors stay coarse: an unusable stored hash reports ErrInvalidHash and
// never says which part of it was wrong, so a caller cannot probe the parser.
//
// Both inputs are bounded before anything is parsed or hashed. An out-of-range
// plaintext can never match a stored hash — hashes are only produced for
// in-range passwords — so it reports a mismatch and, importantly, never reaches
// Argon2: a caller must not be able to trade a few kilobytes of request for
// megabytes of hashing.
func VerifyPassword(plain, encoded string) (bool, error) {
	if !PlaintextWithinBounds(plain) {
		return false, nil
	}
	if !EncodedWithinBounds(encoded) {
		return false, ErrInvalidHash
	}

	hash, err := parsePHC(encoded)
	if err != nil {
		return false, ErrInvalidHash
	}

	// Matches the reference implementation's observable behaviour for every hash
	// this project can produce. The differences (Argon2i/Argon2d hashes and
	// Argon2 v0x10 hashes) are documented in
	// docs/security/go-security-service.md and never occur for stored accounts.
	if hash.algorithm != "argon2id" || hash.version != argon2.Version {
		return false, nil
	}
	// argon2 requires at least 8 salt bytes. The reference hash parser accepts the
	// string and reports the mismatch from inside the hash routine; the answer
	// the caller sees is the same false.
	if len(hash.salt) < 8 {
		return false, nil
	}
	// A stored parameter set that Argon2 would reject is a mismatch, not an
	// unusable hash: password_hash parses it and the failure happens inside the
	// verification routine.
	if !hash.params.valid() || hash.params.MemoryKiB > maxVerifyMemoryKiB {
		return false, nil
	}
	if len(hash.key) != argonKeyLength {
		// The reference verifier always derives the default 32-byte key, so a hash
		// with another length can never match there either.
		return false, nil
	}

	key := argon2.IDKey(
		[]byte(plain),
		hash.salt,
		hash.params.Iterations,
		hash.params.MemoryKiB,
		uint8(hash.params.Parallelism),
		argonKeyLength,
	)
	return subtle.ConstantTimeCompare(key, hash.key) == 1, nil
}

// phcHash is a parsed Argon2 PHC string.
type phcHash struct {
	algorithm string
	version   int
	params    Argon2Params
	salt      []byte
	key       []byte
}

// parsePHC parses the Argon2 PHC string format.
//
// The structural checks mirror password_hash::PasswordHash::new: six
// $-separated fields, a valid identifier, a numeric version, valid base64 salt
// and key. Parameter values are parsed leniently because the reference hash parser
// is lenient too: a structurally valid string with bogus m/t/p values reaches
// the verifier and produces a mismatch, not an unusable-hash error.
func parsePHC(encoded string) (phcHash, error) {
	parts := strings.Split(encoded, "$")
	// ["", algorithm, version, params, salt, key]
	if len(parts) != 6 || parts[0] != "" {
		return phcHash{}, fmt.Errorf("%w: wrong field count", ErrInvalidHash)
	}

	algorithm := parts[1]
	if !validPHCIdent(algorithm) {
		return phcHash{}, fmt.Errorf("%w: invalid algorithm identifier", ErrInvalidHash)
	}

	versionPart := parts[2]
	if !strings.HasPrefix(versionPart, "v=") {
		return phcHash{}, fmt.Errorf("%w: missing version", ErrInvalidHash)
	}
	version, err := strconv.Atoi(versionPart[2:])
	if err != nil {
		return phcHash{}, fmt.Errorf("%w: invalid version", ErrInvalidHash)
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return phcHash{}, fmt.Errorf("%w: invalid salt encoding", ErrInvalidHash)
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return phcHash{}, fmt.Errorf("%w: invalid key encoding", ErrInvalidHash)
	}

	return phcHash{
		algorithm: algorithm,
		version:   version,
		params:    parsePHCParams(parts[3]),
		salt:      salt,
		key:       key,
	}, nil
}

// validPHCIdent reports whether s is a legal PHC identifier ([a-z0-9-], 1..32
// bytes), matching password_hash::Ident::new.
func validPHCIdent(s string) bool {
	if len(s) == 0 || len(s) > 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
			continue
		}
		return false
	}
	return true
}

// parsePHCParams parses the m,t,p parameter string.
//
// Unknown parameters (keyid, data, ...) are ignored, which mirrors the reference
// parser accepting them and then computing with a different Argon2 variant that
// this implementation cannot reproduce; the resulting parameters are treated as
// invalid below so the answer is a mismatch.
func parsePHCParams(raw string) Argon2Params {
	var params Argon2Params
	seen := map[string]bool{}
	for _, field := range strings.Split(raw, ",") {
		name, value, ok := strings.Cut(field, "=")
		if !ok {
			continue
		}
		number, err := strconv.ParseUint(value, 10, 32)
		if err != nil {
			continue
		}
		switch name {
		case "m":
			params.MemoryKiB = uint32(number)
			seen["m"] = true
		case "t":
			params.Iterations = uint32(number)
			seen["t"] = true
		case "p":
			params.Parallelism = uint32(number)
			seen["p"] = true
		}
	}
	if !seen["m"] || !seen["t"] || !seen["p"] {
		return Argon2Params{}
	}
	return params
}

// validateForHashing reports whether the parameters can be passed to Go's
// Argon2id implementation.
func (p Argon2Params) validateForHashing() error {
	if p.Iterations == 0 {
		return errors.New("iterations must be at least 1")
	}
	// argon2.IDKey takes a uint8 lane count.
	if p.Parallelism == 0 || p.Parallelism > 255 {
		return errors.New("parallelism must be between 1 and 255")
	}
	if p.MemoryKiB < 8*p.Parallelism {
		return errors.New("memory must be at least 8 KiB per lane")
	}
	return nil
}

// valid reports whether parsed parameters are inside Argon2's accepted ranges.
func (p Argon2Params) valid() bool {
	return p.validateForHashing() == nil
}
