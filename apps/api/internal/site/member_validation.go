package site

import (
	"fmt"
	"net/mail"
	"strings"
	"unicode/utf8"
)

// Bounds on caller supplied member profile values.
//
// They mirror the auth module's limits: a display name and an email address mean
// the same thing here as they do during registration, and a value the API accepted
// there must not become invalid when an administrator edits it.
const (
	// MaxMemberDisplayNameLength bounds a display name.
	MaxMemberDisplayNameLength = 120
	// MaxMemberEmailLength is the RFC limit for an address.
	MaxMemberEmailLength = 320
)

// normalizeMemberEmail lowercases, trims and validates a login address.
//
// Case folding matters: "Alice@Example.com" and "alice@example.com" are one login
// identity, so editing an address must apply the same normalisation as creating it.
func normalizeMemberEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if email == "" {
		return "", fmt.Errorf("%w: email is required", ErrInvalidInput)
	}
	if len(email) > MaxMemberEmailLength {
		return "", fmt.Errorf("%w: email is too long", ErrInvalidInput)
	}

	parsed, err := mail.ParseAddress(email)
	if err != nil {
		return "", fmt.Errorf("%w: email is malformed", ErrInvalidInput)
	}
	// Reject the "Name <addr>" form: the login identity is the bare address.
	if parsed.Address != email {
		return "", fmt.Errorf("%w: email must be a bare address", ErrInvalidInput)
	}
	return email, nil
}

// validateMemberDisplayName trims and bounds a display name.
func validateMemberDisplayName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("%w: display name is required", ErrInvalidInput)
	}
	if utf8.RuneCountInString(name) > MaxMemberDisplayNameLength {
		return "", fmt.Errorf("%w: display name is too long", ErrInvalidInput)
	}
	return name, nil
}
