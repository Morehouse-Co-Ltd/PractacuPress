package auth

import (
	"fmt"
	"net/mail"
	"strings"
	"unicode/utf8"
)

// Bounds on caller supplied input.
//
// They are enforced before any expensive work (hashing, database access) so an
// oversized payload cannot be used to burn CPU.
const (
	// MinPasswordLength is the shortest accepted password.
	MinPasswordLength = 8
	// MaxPasswordLength bounds the input to Argon2.
	MaxPasswordLength = 128
	// MaxDisplayNameLength bounds a display name.
	MaxDisplayNameLength = 120
	// MaxEmailLength is the RFC limit for an address.
	MaxEmailLength = 320
)

// NormalizeEmail lowercases and trims an address, then validates it.
//
// Case folding is what makes "Alice@Example.com" and "alice@example.com" a single
// account rather than two accounts that look identical to a user.
func NormalizeEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if email == "" {
		return "", fmt.Errorf("%w: email is required", ErrInvalidInput)
	}
	if len(email) > MaxEmailLength {
		return "", fmt.Errorf("%w: email is too long", ErrInvalidInput)
	}

	parsed, err := mail.ParseAddress(email)
	if err != nil {
		return "", fmt.Errorf("%w: email is malformed", ErrInvalidInput)
	}
	// Reject the "Name <addr>" form: the identity is the bare address.
	if parsed.Address != email {
		return "", fmt.Errorf("%w: email must be a bare address", ErrInvalidInput)
	}
	return email, nil
}

// ValidatePassword enforces length bounds before hashing.
func ValidatePassword(raw string) error {
	length := utf8.RuneCountInString(raw)
	switch {
	case length < MinPasswordLength:
		return fmt.Errorf("%w: password must be at least %d characters", ErrInvalidInput, MinPasswordLength)
	case length > MaxPasswordLength:
		return fmt.Errorf("%w: password must be at most %d characters", ErrInvalidInput, MaxPasswordLength)
	default:
		return nil
	}
}

// ValidateDisplayName trims and bounds a display name.
func ValidateDisplayName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("%w: display name is required", ErrInvalidInput)
	}
	if utf8.RuneCountInString(name) > MaxDisplayNameLength {
		return "", fmt.Errorf("%w: display name is too long", ErrInvalidInput)
	}
	return name, nil
}
