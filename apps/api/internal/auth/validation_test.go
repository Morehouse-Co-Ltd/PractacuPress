package auth

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// elevenRunes is one rune below the minimum: it keeps the length boundary tests
// honest even if somebody drops MinPasswordLength back down.
const elevenRunes = "Aa1!Aa1!Aa1"

// TestValidatePasswordPolicy pins the V-30 policy: 12 to 128 characters, no all
// whitespace password, at least two character classes and no classic weak password.
func TestValidatePasswordPolicy(t *testing.T) {
	require.Equal(t, 12, MinPasswordLength, "the minimum length is the policy the client mirrors")
	require.Equal(t, 128, MaxPasswordLength)

	tooLong := strings.Repeat("Aa1!", 32) + "A" // 129 runes
	maxLength := strings.Repeat("Aa1!", 32)     // 128 runes

	tests := []struct {
		name     string
		password string
		wantErr  bool
	}{
		{name: "empty", password: "", wantErr: true},
		{name: "eleven characters", password: elevenRunes, wantErr: true},
		{name: "twelve characters at the boundary", password: "Aa1!Aa1!Aa1!"},
		{name: "too long", password: tooLong, wantErr: true},
		{name: "exactly max length", password: maxLength},

		// The attack from the report: eight spaces used to be a valid password. The
		// blank rule has to be exercised at or above the new minimum, otherwise the
		// length rule shadows it.
		{name: "twelve spaces", password: strings.Repeat(" ", 12), wantErr: true},
		{name: "mixed whitespace", password: " \t \r\n  \t \r\n  ", wantErr: true},

		// Single class passwords long enough to reach the class rule (a short one is
		// rejected as too_short first, which would hide a class rule regression).
		{name: "only lowercase", password: "passwordpassword", wantErr: true},
		{name: "only uppercase", password: "PASSWORDPASSWORD", wantErr: true},
		{name: "only digits", password: "908172635410", wantErr: true},
		{name: "only symbols", password: "!@#$%^&*!@#$", wantErr: true},
		{name: "only uncased letters", password: "密码密码密码密码密码密码", wantErr: true},

		{name: "lower and upper", password: "PasswordPassword"},
		{name: "lower and digit", password: "pass1234pass"},
		{name: "upper and digit", password: "ABCDEF123456"},
		{name: "lower and symbol", password: "pass!!!!pass"},
		// Existing fixtures and passphrases of this codebase: the space counts as the
		// symbol class, so a passphrase is not rejected.
		{name: "passphrase with spaces", password: "correct horse battery"},
		{name: "uncased letters and digit", password: "密码密码密码密码密码密码1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePassword(tt.password)
			if tt.wantErr {
				require.ErrorIs(t, err, ErrInvalidInput)
				return
			}
			require.NoError(t, err)
		})
	}
}

// TestValidatePasswordRejectsCommonPasswords is the too_common rule: the password is
// long and classy enough, but it is one of the classic weak passwords. Matching is
// case insensitive, and the common numeric/leet suffixes are covered by the list.
func TestValidatePasswordRejectsCommonPasswords(t *testing.T) {
	weak := []string{
		"Password1234", // 12 runes, three classes: only the blocklist rejects it
		"PASSWORD1234",
		"qwerty123456",
		"1q2w3e4r5t6y",
		"passw0rd1234",
		"p@ssw0rd1234",
		"iloveyou1234",
		"letmein12345",
		"admin123456789",
		"welcome12345",
		"dragon123456",
		"princess1234",
	}

	for _, password := range weak {
		t.Run(password, func(t *testing.T) {
			require.GreaterOrEqual(t, len([]rune(password)), MinPasswordLength,
				"the fixture must be rejected by the blocklist, not by its length")

			err := ValidatePassword(password)
			require.ErrorIs(t, err, ErrInvalidInput)

			var fieldErr *apperr.FieldError
			require.ErrorAs(t, err, &fieldErr)
			require.Equal(t, "password", fieldErr.Field)
			require.Equal(t, "too_common", fieldErr.Rule)
			require.NotEmpty(t, fieldErr.Reason)
		})
	}
}

// TestCommonPasswordBlocklistCoversClassics guards the content of the embedded list:
// a few hundred entries, including the passwords every credential-stuffing list
// starts with, matched without regard to case.
func TestCommonPasswordBlocklistCoversClassics(t *testing.T) {
	require.GreaterOrEqual(t, len(commonPasswords), 300,
		"the blocklist must stay a real list, not a handful of tokens")

	classics := []string{
		"password", "123456", "qwerty", "letmein", "iloveyou",
		"admin", "welcome", "passw0rd", "1q2w3e4r",
	}
	for _, password := range classics {
		require.True(t, isCommonPassword(password), password)
		require.True(t, isCommonPassword(strings.ToUpper(password)),
			"%s must match case insensitively", password)
	}

	// Exact match only: a long legit password that merely contains a blocked word is
	// not rejected as common (the class/length rules still apply to it).
	require.True(t, isCommonPassword("Password1234"))
	require.False(t, isCommonPassword("my Password1234 passphrase"))
	require.False(t, isCommonPassword("Password1234x"))
	require.False(t, isCommonPassword("correct horse battery"))
}

// TestValidationErrorsCarryFieldAndRule pins the machine vocabulary the client uses to
// explain a rejected form: the sentinel must stay matchable for the transport, while the
// FieldError names the input and the broken rule.
func TestValidationErrorsCarryFieldAndRule(t *testing.T) {
	tests := []struct {
		name  string
		call  func() error
		field string
		rule  string
	}{
		{
			name:  "empty email",
			call:  func() error { _, err := NormalizeEmail(""); return err },
			field: "email", rule: "required",
		},
		{
			name:  "malformed email",
			call:  func() error { _, err := NormalizeEmail("not-an-email"); return err },
			field: "email", rule: "malformed",
		},
		{
			name: "over-long email",
			call: func() error {
				_, err := NormalizeEmail(strings.Repeat("a", 300) + "@example.com")
				return err
			},
			field: "email", rule: "too_long",
		},
		{
			name:  "short password",
			call:  func() error { return ValidatePassword(elevenRunes) }, // 11 runes
			field: "password", rule: "too_short",
		},
		{
			name:  "long password",
			call:  func() error { return ValidatePassword(strings.Repeat("Aa1!", 32) + "A") }, // 129 runes
			field: "password", rule: "too_long",
		},
		{
			name:  "blank password",
			call:  func() error { return ValidatePassword(strings.Repeat(" ", 12)) }, // twelve spaces
			field: "password", rule: "blank",
		},
		{
			name:  "weak password",
			call:  func() error { return ValidatePassword("passwordpassword") },
			field: "password", rule: "too_weak",
		},
		{
			name:  "common password",
			call:  func() error { return ValidatePassword("Password1234") },
			field: "password", rule: "too_common",
		},
		{
			name:  "missing display name",
			call:  func() error { _, err := ValidateDisplayName("   "); return err },
			field: "display_name", rule: "required",
		},
		{
			name: "over-long display name",
			call: func() error {
				_, err := ValidateDisplayName(strings.Repeat("长", MaxDisplayNameLength+1))
				return err
			},
			field: "display_name", rule: "too_long",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call()
			require.ErrorIs(t, err, ErrInvalidInput, "the transport still matches the sentinel")

			var fieldErr *apperr.FieldError
			require.ErrorAs(t, err, &fieldErr, "the error names the failing field")
			require.Equal(t, tt.field, fieldErr.Field)
			require.Equal(t, tt.rule, fieldErr.Rule)
			require.NotEmpty(t, fieldErr.Reason, "operators keep the english reason")
		})
	}

	// A valid password is not an error at all.
	require.NoError(t, ValidatePassword("correct horse battery"))
	require.NoError(t, ValidatePassword("GoodPass123!"))
}

// TestNormalizeEmailStaysBelowPersistenceLength is the V-28 regression: the API must
// reject an address before the schema's 255 character bound can turn it into a 500.
func TestNormalizeEmailStaysBelowPersistenceLength(t *testing.T) {
	require.Equal(t, 254, MaxEmailLength, "the API bound must stay below the schema MaxLen(255)")

	// 242 local part characters + "@example.com" (12) = 254 octets.
	atLimit := strings.Repeat("a", 242) + "@example.com"
	require.Len(t, atLimit, MaxEmailLength)

	normalized, err := NormalizeEmail(atLimit)
	require.NoError(t, err, "an address at the API limit must be accepted by validation")
	require.Len(t, normalized, MaxEmailLength)

	overLimit := strings.Repeat("a", 243) + "@example.com"
	require.Len(t, overLimit, MaxEmailLength+1)
	_, err = NormalizeEmail(overLimit)
	require.ErrorIs(t, err, ErrInvalidInput,
		"one octet over the API limit must be an invalid input error, not a schema failure")
}
