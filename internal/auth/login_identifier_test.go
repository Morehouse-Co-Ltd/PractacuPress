package auth_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

// loginWith posts the password login endpoint with the given body.
func loginWith(t *testing.T, h *apiHarness, body map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	return h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", body))
}

const invalidPassword = "definitely wrong"

// TestLoginAcceptsEmailOrDisplayName pins the two supported identifiers.
func TestLoginAcceptsEmailOrDisplayName(t *testing.T) {
	h := newAPIHarness(t)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	byEmail := loginWith(t, h, map[string]string{
		"email": "alice@example.com", "password": "correct horse battery",
	})
	require.Equal(t, http.StatusOK, byEmail.Code)
	require.NotEmpty(t, decode(t, byEmail)["access_token"])

	byIdentifierEmail := loginWith(t, h, map[string]string{
		"identifier": "alice@example.com", "password": "correct horse battery",
	})
	require.Equal(t, http.StatusOK, byIdentifierEmail.Code)
	require.NotEmpty(t, decode(t, byIdentifierEmail)["access_token"])

	// The seeded display name of the registration helper is "Alice".
	byUsername := loginWith(t, h, map[string]string{
		"identifier": "Alice", "password": "correct horse battery",
	})
	require.Equal(t, http.StatusOK, byUsername.Code)
	require.NotEmpty(t, decode(t, byUsername)["access_token"])

	// Display names are matched case-insensitively, and the identifier is trimmed.
	byFolded := loginWith(t, h, map[string]string{
		"identifier": "  alice  ", "password": "correct horse battery",
	})
	require.Equal(t, http.StatusOK, byFolded.Code)
	require.NotEmpty(t, decode(t, byFolded)["access_token"])
}

// TestLoginIdentifierWinsOverLegacyEmail keeps the documented precedence stable.
func TestLoginIdentifierWinsOverLegacyEmail(t *testing.T) {
	h := newAPIHarness(t)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	// The legacy field names a different account, but identifier must win.
	response := loginWith(t, h, map[string]string{
		"identifier": "alice@example.com",
		"email":      "someone-else@example.com",
		"password":   "correct horse battery",
	})
	require.Equal(t, http.StatusOK, response.Code)
	user := decode(t, response)["user"].(map[string]any)
	require.Equal(t, "Alice", user["display_name"])
}

// TestLoginAmbiguousDisplayNameIsRefused documents the limitation: display names are
// not unique, so a shared name cannot log in and must fall back to an email.
func TestLoginAmbiguousDisplayNameIsRefused(t *testing.T) {
	h := newAPIHarness(t)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)
	require.Equal(t, http.StatusCreated, register(t, h, "bob@example.com").Code)

	// Both registrations use the display name "Alice" through the harness helper.
	ambiguous := loginWith(t, h, map[string]string{
		"identifier": "Alice", "password": "correct horse battery",
	})
	require.Equal(t, http.StatusUnauthorized, ambiguous.Code)
	require.Equal(t, "invalid_credentials", problemReason(t, ambiguous))

	// Each account can still log in by its email.
	for _, email := range []string{"alice@example.com", "bob@example.com"} {
		ok := loginWith(t, h, map[string]string{
			"identifier": email, "password": "correct horse battery",
		})
		require.Equal(t, http.StatusOK, ok.Code, email)
	}
}

// TestLoginUnknownUsernameIsIndistinguishableFromWrongPassword keeps V-13 intact for
// the new identifier: identical body and one dummy hash verification.
func TestLoginUnknownUsernameIsIndistinguishableFromWrongPassword(t *testing.T) {
	hasher := &fakeHasher{}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: hasher})
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	unknown := loginWith(t, h, map[string]string{
		"identifier": "Nobody", "password": invalidPassword,
	})
	require.Equal(t, http.StatusUnauthorized, unknown.Code)
	require.Equal(t, "invalid_credentials", problemReason(t, unknown))
	calls := hasher.verifyCalls()
	require.Len(t, calls, 1, "an unknown username must still spend one verification")
	require.Contains(t, calls[0], "$argon2id$")

	wrong := loginWith(t, h, map[string]string{
		"identifier": "Alice", "password": invalidPassword,
	})
	require.Equal(t, http.StatusUnauthorized, wrong.Code)

	// Bodies are identical apart from the per-request correlation id.
	unknownPayload := decode(t, unknown)
	wrongPayload := decode(t, wrong)
	delete(unknownPayload, "request_id")
	delete(wrongPayload, "request_id")
	require.Equal(t, wrongPayload, unknownPayload)
}

// TestLoginWrongPasswordByUsernameCountsAgainstTheAccount makes sure username and
// email failures share one lockout streak: the fifth wrong password locks the account
// regardless of which identifier was used.
func TestLoginWrongPasswordByUsernameCountsAgainstTheAccount(t *testing.T) {
	h := newAPIHarness(t)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	for attempt := 0; attempt < 5; attempt += 1 {
		identifier := "Alice"
		if attempt%2 == 1 {
			identifier = "alice@example.com"
		}
		response := loginWith(t, h, map[string]string{
			"identifier": identifier, "password": invalidPassword,
		})
		require.Equal(t, http.StatusUnauthorized, response.Code, "attempt %d", attempt)
	}

	// The next failed attempt is locked out, whether it uses the username or the email.
	locked := loginWith(t, h, map[string]string{
		"identifier": "alice@example.com", "password": invalidPassword,
	})
	require.Equal(t, http.StatusTooManyRequests, locked.Code)

	// The lock is a failure backoff, not a permanent account freeze: the correct
	// password is still verified and clears the streak (existing documented behaviour).
	unlocked := loginWith(t, h, map[string]string{
		"identifier": "Alice", "password": "correct horse battery",
	})
	require.Equal(t, http.StatusOK, unlocked.Code)
}
