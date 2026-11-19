package auth

import (
	"sync"
	"time"
)

// Login policy constants.
const (
	// dummyPasswordHash is a fixed, valid Argon2id PHC string that is verified when no
	// account matches the submitted email. Without it an unknown address would return
	// before any hashing and the response time would reveal whether the account
	// exists; with it both paths spend the same work.
	//
	// It must stay a real PHC string with the production cost parameters (64 MiB,
	// 3 iterations, 2 lanes). The plaintext behind it is unimportant: the comparison
	// is expected to fail.
	dummyPasswordHash = "$argon2id$v=19$m=65536,t=3,p=2$WcedXGXESeJg5oY0f387og$Md4YBG4d4WHfDRLHMt+af3Kiwpm4u3yum50Un4IQQRo"

	// loginFailureWindow is how long a failed attempt counts towards the streak. A
	// pause longer than this starts a fresh streak.
	loginFailureWindow = 15 * time.Minute
	// loginFailureThreshold is the number of failures inside the window that starts
	// locking the account.
	loginFailureThreshold = 5
	// loginLockBase is the lock applied at the threshold; each further failure
	// doubles it.
	loginLockBase = time.Minute
	// loginLockMax caps the exponential backoff.
	loginLockMax = 15 * time.Minute
	// loginThrottleCapacity bounds the in-process table so a flood of distinct
	// addresses cannot grow it without limit.
	loginThrottleCapacity = 4096
)

// TooManyAttemptsError reports a locked out account and how long the caller should
// wait before trying again.
type TooManyAttemptsError struct {
	// RetryAfter is the remaining lock time.
	RetryAfter time.Duration
}

// Error implements the error interface.
func (e *TooManyAttemptsError) Error() string {
	return ErrTooManyAttempts.Error()
}

// Is makes errors.Is(err, ErrTooManyAttempts) true for the typed lock error.
func (e *TooManyAttemptsError) Is(target error) bool { return target == ErrTooManyAttempts }

// loginFailureState is the per-address failure streak.
type loginFailureState struct {
	failures     int
	firstFailure time.Time
	lastFailure  time.Time
	lockedUntil  time.Time
}

// loginThrottle is an in-process, bounded failure counter keyed by the normalised
// email address.
//
// It is the account scoped half of the two tier defence: the IP scoped credential
// limiter still runs in front of the endpoint, this one survives across source
// addresses. It is NOT shared between replicas. A multi replica deployment needs a
// shared store (Redis or a database row) for the counter and lock to be consistent;
// with the current single process table each replica would allow its own streak.
//
// The table is deliberately small: the credential limiter is the first line, so an
// attacker who can create more than loginThrottleCapacity distinct streaks is
// already spending their per IP budget. When the table is full the oldest streaks
// are swept first.
type loginThrottle struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]*loginFailureState
}

func newLoginThrottle(now func() time.Time) *loginThrottle {
	return &loginThrottle{now: now, entries: make(map[string]*loginFailureState)}
}

// blocked reports whether email is locked out and for how much longer.
func (t *loginThrottle) blocked(email string) (time.Duration, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()

	state, ok := t.entries[email]
	if !ok {
		return 0, false
	}
	now := t.now()
	if now.Before(state.lockedUntil) {
		return state.lockedUntil.Sub(now), true
	}
	return 0, false
}

// failure records a failed attempt and returns the lock duration it triggered, if
// any.
func (t *loginThrottle) failure(email string) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()

	now := t.now()
	state, ok := t.entries[email]
	if !ok || now.Sub(state.lastFailure) > loginFailureWindow {
		// First failure, or the streak went stale.
		state = &loginFailureState{firstFailure: now}
		t.entries[email] = state
		if len(t.entries) > loginThrottleCapacity {
			t.sweepLocked(now)
		}
	}

	state.failures++
	state.lastFailure = now
	if state.failures < loginFailureThreshold {
		return 0
	}

	shift := state.failures - loginFailureThreshold
	if shift > 8 {
		shift = 8
	}
	lock := loginLockBase * time.Duration(1<<uint(shift))
	if lock > loginLockMax {
		lock = loginLockMax
	}
	state.lockedUntil = now.Add(lock)
	return lock
}

// success forgets the failure history of an address.
func (t *loginThrottle) success(email string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, email)
}

// sweepLocked drops streaks that can no longer matter. Callers must hold mu.
func (t *loginThrottle) sweepLocked(now time.Time) {
	for email, state := range t.entries {
		if now.Before(state.lockedUntil) {
			continue
		}
		if now.Sub(state.lastFailure) >= loginFailureWindow {
			delete(t.entries, email)
		}
	}
	// A burst of distinct addresses can fill the table inside one window. Keep the
	// memory bound hard: evict an arbitrary entry rather than growing without limit.
	for len(t.entries) > loginThrottleCapacity {
		for email := range t.entries {
			delete(t.entries, email)
			break
		}
	}
}
