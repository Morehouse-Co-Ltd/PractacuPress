package auth

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestValidatePasswordPolicy pins the V-30 policy: length bounds, no all whitespace
// password and at least two character classes.
func TestValidatePasswordPolicy(t *testing.T) {
	tooShort := strings.Repeat("Aa1!", 1) + "Aa1" // 7 runes
	tooLong := strings.Repeat("Aa1!", 32) + "A"   // 129 runes
	maxLength := strings.Repeat("Aa1!", 32)       // 128 runes

	tests := []struct {
		name     string
		password string
		wantErr  bool
	}{
		{name: "empty", password: "", wantErr: true},
		{name: "too short", password: tooShort, wantErr: true},
		{name: "too long", password: tooLong, wantErr: true},
		{name: "exactly max length", password: maxLength},

		// The attack from the report: eight spaces used to be a valid password.
		{name: "eight spaces", password: "        ", wantErr: true},
		{name: "mixed whitespace", password: " \t \r\n  ", wantErr: true},

		{name: "only lowercase", password: "password", wantErr: true},
		{name: "only uppercase", password: "PASSWORD", wantErr: true},
		{name: "only digits", password: "12345678", wantErr: true},
		{name: "only symbols", password: "!@#$%^&*", wantErr: true},
		{name: "only uncased letters", password: "密码密码密码密码", wantErr: true},

		{name: "lower and upper", password: "Password"},
		{name: "lower and digit", password: "pass1234"},
		{name: "upper and digit", password: "PASSWORD1"},
		{name: "lower and symbol", password: "pass!!!!"},
		// Existing fixtures and passphrases of this codebase: the space counts as the
		// symbol class, so a passphrase is not rejected.
		{name: "passphrase with spaces", password: "correct horse battery"},
		{name: "uncased letters and digit", password: "密码密码密码密码1"},
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
