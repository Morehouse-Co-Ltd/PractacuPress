package auth

import (
	"fmt"
	"net/mail"
	"strings"
	"unicode"
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
	// MaxEmailLength is the RFC 5321 maximum for a bare address (254 octets). It is
	// deliberately below the persistence bound on the identity subject (255): an
	// address this layer accepts must never be rejected by the schema, which would
	// turn a validation failure into a 500.
	MaxEmailLength = 254
	// minPasswordClasses is how many distinct character classes a new password must
	// combine: lowercase, uppercase, digits and symbols (spaces count as symbols, but
	// an all whitespace password is rejected before the class check).
	minPasswordClasses = 2
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

// ValidatePassword enforces the password policy before hashing.
//
// The policy is: 8 to 128 characters, not entirely whitespace, and at least two of
// the four character classes. It only gates the creation of a password (registration,
// reset and administrator created accounts); login accepts whatever was stored, so an
// account created before this policy existed keeps working.
func ValidatePassword(raw string) error {
	length := utf8.RuneCountInString(raw)
	switch {
	case length < MinPasswordLength:
		return fmt.Errorf("%w: password must be at least %d characters", ErrInvalidInput, MinPasswordLength)
	case length > MaxPasswordLength:
		return fmt.Errorf("%w: password must be at most %d characters", ErrInvalidInput, MaxPasswordLength)
	}
	if strings.TrimSpace(raw) == "" {
		return fmt.Errorf("%w: password must not be only whitespace", ErrInvalidInput)
	}
	if classes := passwordClasses(raw); classes < minPasswordClasses {
		return fmt.Errorf(
			"%w: password must combine at least %d of lowercase, uppercase, digits and symbols",
			ErrInvalidInput, minPasswordClasses)
	}
	return nil
}

// passwordClasses counts how many distinct character classes a password uses.
//
// Uncased letters (CJK, Arabic, ...) count as the letter class so a passphrase does
// not have to mix scripts just to satisfy the counter.
func passwordClasses(raw string) int {
	var lower, upper, digit, symbol bool
	for _, r := range raw {
		switch {
		case unicode.IsLower(r):
			lower = true
		case unicode.IsUpper(r):
			upper = true
		case unicode.IsDigit(r):
			digit = true
		case unicode.IsLetter(r):
			lower = true
		default:
			symbol = true
		}
	}

	classes := 0
	for _, used := range []bool{lower, upper, digit, symbol} {
		if used {
			classes++
		}
	}
	return classes
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
