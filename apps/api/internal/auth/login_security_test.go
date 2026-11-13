package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	entuser "github.com/practacu/practacu-press/apps/api/ent/user"
)

// TestLoginUnknownAccountRunsDummyVerification is the V-13 regression. An unknown
// address must still run one password verification against the fixed placeholder PHC,
// so response time does not reveal whether the account exists.
func TestLoginUnknownAccountRunsDummyVerification(t *testing.T) {
	hasher := &fakeHasher{}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: hasher})
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	unknown := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "nobody@example.com", "password": "correct horse battery",
	}))
	require.Equal(t, http.StatusUnauthorized, unknown.Code)
	require.Equal(t, "invalid_credentials", problemReason(t, unknown))

	calls := hasher.verifyCalls()
	require.Len(t, calls, 1, "an unknown address must still spend one verification")
	dummy := calls[0]
	require.Contains(t, dummy, "$argon2id$", "the placeholder must be a real PHC string")
	require.NotEqual(t, fakeEncoding("correct horse battery"), dummy,
		"the placeholder is not the account's stored hash")

	// Every unknown address gets the same fixed placeholder: it is a constant, not a
	// freshly hashed value.
	unknown2 := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "also-nobody@example.com", "password": "correct horse battery",
	}))
	require.Equal(t, http.StatusUnauthorized, unknown2.Code)
	calls = hasher.verifyCalls()
	require.Len(t, calls, 2)
	require.Equal(t, dummy, calls[1])

	// A known account verifies against its stored hash, not the placeholder.
	wrong := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "alice@example.com", "password": "definitely wrong",
	}))
	require.Equal(t, http.StatusUnauthorized, wrong.Code)
	calls = hasher.verifyCalls()
	require.Len(t, calls, 3)
	require.Equal(t, fakeEncoding("correct horse battery"), calls[2])
	require.NotEqual(t, dummy, calls[2])
}

// TestLoginUnknownAccountSpendsComparableWork proves the dummy verification is not a
// no-op: the unknown branch goes through the (deliberately slow) verify path.
func TestLoginUnknownAccountSpendsComparableWork(t *testing.T) {
	const delay = 40 * time.Millisecond
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &sleepingHasher{delay: delay}})
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	start := time.Now()
	unknown := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "nobody@example.com", "password": "correct horse battery",
	}))
	unknownElapsed := time.Since(start)
	require.Equal(t, http.StatusUnauthorized, unknown.Code)
	require.GreaterOrEqual(t, unknownElapsed, delay*3/4,
		"the unknown account branch must run the hash verification")

	start = time.Now()
	known := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "alice@example.com", "password": "definitely wrong",
	}))
	knownElapsed := time.Since(start)
	require.Equal(t, http.StatusUnauthorized, known.Code)
	require.GreaterOrEqual(t, knownElapsed, delay*3/4,
		"the known account branch runs the same verification")
}

// TestLoginDisabledAccountIsIndistinguishable is the second half of V-13: a disabled
// account must answer exactly like a wrong password instead of exposing its state.
func TestLoginDisabledAccountIsIndistinguishable(t *testing.T) {
	hasher := &fakeHasher{}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: hasher})
	registered := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, registered.Code)

	payload := decode(t, registered)
	user, ok := payload["user"].(map[string]any)
	require.True(t, ok)
	userID, _ := user["id"].(string)
	require.NotEmpty(t, userID)

	_, err := h.db.Client.User.Update().
		Where(entuser.IDEQ(userID)).
		SetStatus("disabled").
		Save(context.Background())
	require.NoError(t, err)

	disabled := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "alice@example.com", "password": "correct horse battery",
	}))
	wrong := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "alice@example.com", "password": "definitely wrong",
	}))

	require.Equal(t, http.StatusUnauthorized, disabled.Code,
		"a disabled account must not answer with its own status code")
	require.Equal(t, wrong.Code, disabled.Code)

	// The bodies are identical apart from the per-request correlation id.
	wrongPayload := decode(t, wrong)
	disabledPayload := decode(t, disabled)
	delete(wrongPayload, "request_id")
	delete(disabledPayload, "request_id")
	require.Equal(t, wrongPayload, disabledPayload,
		"the disabled response must be indistinguishable from a wrong password response")
}

// TestLoginBackoffDoesNotLeakAccountExistence proves the V-24 lockout cannot itself
// become an enumeration oracle: an unknown address has to lock exactly like a
// registered one.
func TestLoginBackoffDoesNotLeakAccountExistence(t *testing.T) {
	clock := newTestClock(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &fakeHasher{}, now: clock.Now})
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	fail := func(email string) *httptest.ResponseRecorder {
		return h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
			"email": email, "password": "definitely wrong",
		}))
	}

	for attempt := 1; attempt <= 5; attempt++ {
		require.Equal(t, http.StatusUnauthorized, fail("alice@example.com").Code)
	}
	knownLocked := fail("alice@example.com")
	require.Equal(t, http.StatusTooManyRequests, knownLocked.Code, "registered address is locked")

	for attempt := 1; attempt <= 5; attempt++ {
		require.Equal(t, http.StatusUnauthorized, fail("nobody@example.com").Code)
	}
	unknownLocked := fail("nobody@example.com")
	require.Equal(t, http.StatusTooManyRequests, unknownLocked.Code,
		"an unknown address has to lock too, otherwise the lockout reveals existence")

	knownPayload := decode(t, knownLocked)
	unknownPayload := decode(t, unknownLocked)
	delete(knownPayload, "request_id")
	delete(unknownPayload, "request_id")
	require.Equal(t, knownPayload, unknownPayload)
}

// TestLoginBackoffAfterRepeatedFailures is the V-24 regression: the account is locked
// with a Retry-After after the failure threshold, and unlocks when the window passes.
func TestLoginBackoffAfterRepeatedFailures(t *testing.T) {
	clock := newTestClock(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &fakeHasher{}, now: clock.Now})
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	for attempt := 1; attempt <= 5; attempt++ {
		w := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
			"email": "alice@example.com", "password": "definitely wrong",
		}))
		require.Equal(t, http.StatusUnauthorized, w.Code, "attempt %d", attempt)
	}

	// Wrong passwords keep receiving backoff responses after the account is locked.
	locked := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "alice@example.com", "password": "definitely wrong",
	}))
	require.Equal(t, http.StatusTooManyRequests, locked.Code)
	require.Equal(t, "rate_limited", decode(t, locked)["code"])
	require.Equal(t, "too_many_attempts", problemReason(t, locked))
	retryAfter, err := strconv.Atoi(locked.Header().Get("Retry-After"))
	require.NoError(t, err)
	require.GreaterOrEqual(t, retryAfter, 1)

	// A failure-only backoff must not let an attacker lock the owner out.
	accepted := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "alice@example.com", "password": "correct horse battery",
	}))
	require.Equal(t, http.StatusOK, accepted.Code, accepted.Body.String())

	// The first backoff is one minute; a little past it the account works again.
	clock.Advance(61 * time.Second)
	unlocked := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "alice@example.com", "password": "correct horse battery",
	}))
	require.Equal(t, http.StatusOK, unlocked.Code, "a successful login after the window clears the streak")
}

// TestLoginBackoffEscalates proves the backoff doubles after each further failure.
func TestLoginBackoffEscalates(t *testing.T) {
	clock := newTestClock(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &fakeHasher{}, now: clock.Now})
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	attemptWrong := func() *httptest.ResponseRecorder {
		return h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
			"email": "alice@example.com", "password": "definitely wrong",
		}))
	}

	for attempt := 1; attempt <= 5; attempt++ {
		require.Equal(t, http.StatusUnauthorized, attemptWrong().Code)
	}

	// The first lock lasts one minute; a wrong password after it expires starts the
	// next, longer backoff.
	clock.Advance(61 * time.Second)
	require.Equal(t, http.StatusUnauthorized, attemptWrong().Code)

	locked := attemptWrong()
	require.Equal(t, http.StatusTooManyRequests, locked.Code)
	retryAfter, err := strconv.Atoi(locked.Header().Get("Retry-After"))
	require.NoError(t, err)
	require.GreaterOrEqual(t, retryAfter, 119, "the second lock doubles to two minutes")
	require.LessOrEqual(t, retryAfter, 120)

	accepted := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "alice@example.com", "password": "correct horse battery",
	}))
	require.Equal(t, http.StatusOK, accepted.Code, "backoff must not lock out the account owner")

	// After the escalated lock the owner can log in again.
	clock.Advance(121 * time.Second)
	recovered := h.do(t, newJSONRequest(t, "/api/v1/auth/login/password", map[string]string{
		"email": "alice@example.com", "password": "correct horse battery",
	}))
	require.Equal(t, http.StatusOK, recovered.Code)
}

// TestDuplicateRegistrationPaysTheHashingCost is the conservative half of V-29: the
// 409 identity_exists status is kept (the SPA branches on it), but the duplicate path
// still pays the same expensive hashing step as a successful registration, so timing
// cannot be used to enumerate faster than the explicit status allows.
func TestDuplicateRegistrationPaysTheHashingCost(t *testing.T) {
	hasher := &fakeHasher{}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: hasher})

	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)
	require.Equal(t, 1, hasher.hashes())

	duplicate := register(t, h, "ALICE@example.com")
	require.Equal(t, http.StatusConflict, duplicate.Code)
	require.Equal(t, "conflict", decode(t, duplicate)["code"])
	require.Equal(t, "identity_exists", problemReason(t, duplicate))
	require.Equal(t, 2, hasher.hashes(),
		"the duplicate path must hash the password before the uniqueness check")
}
