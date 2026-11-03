package auth

import (
	"fmt"
	"net/mail"
	"strings"
	"unicode"
	"unicode/utf8"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// invalidField builds a field error that stays matchable as ErrInvalidInput.
//
// Both sentinels are wrapped: errors.Is(err, ErrInvalidInput) keeps working for the
// transport, while errors.As(err, &FieldError) recovers the field and rule the client
// translates. FieldError itself lives in the error model package and cannot reference
// this package's sentinel without an import cycle, which is why the wrapping happens
// here rather than in an Unwrap method.
func invalidField(field, rule, reason string) error {
	return fmt.Errorf("%w: %w", ErrInvalidInput, &apperr.FieldError{
		Field:  field,
		Rule:   rule,
		Reason: reason,
	})
}

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
		return "", invalidField("email", "required", "email is required")
	}
	if len(email) > MaxEmailLength {
		return "", invalidField("email", "too_long", "email is too long")
	}

	parsed, err := mail.ParseAddress(email)
	if err != nil {
		return "", invalidField("email", "malformed", "email is malformed")
	}
	// Reject the "Name <addr>" form: the identity is the bare address.
	if parsed.Address != email {
		return "", invalidField("email", "malformed", "email must be a bare address")
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
		return invalidField("password", "too_short",
			fmt.Sprintf("password must be at least %d characters", MinPasswordLength))
	case length > MaxPasswordLength:
		return invalidField("password", "too_long",
			fmt.Sprintf("password must be at most %d characters", MaxPasswordLength))
	}
	if strings.TrimSpace(raw) == "" {
		return invalidField("password", "blank", "password must not be only whitespace")
	}
	if classes := passwordClasses(raw); classes < minPasswordClasses {
		return invalidField("password", "too_weak", fmt.Sprintf(
			"password must combine at least %d of lowercase, uppercase, digits and symbols",
			minPasswordClasses))
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
		return "", invalidField("display_name", "required", "display name is required")
	}
	if utf8.RuneCountInString(name) > MaxDisplayNameLength {
		return "", invalidField("display_name", "too_long", "display name is too long")
	}
	return name, nil
}
