package auth

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"testing"
	"time"
)

// The state store tests are pure in-process: no clock, no provider, no network.
// Time is injected either through the store's clock or through ExpiresAt values
// placed in the past/future, so every case is deterministic.

// mustCreateOAuthState creates one record and fails the test on error.
func mustCreateOAuthState(t *testing.T, store *MemoryOAuthStateStore, st OAuthState) {
	t.Helper()
	if err := store.Create(context.Background(), st); err != nil {
		t.Fatalf("Create(%q) returned error: %v", st.State, err)
	}
}

// oauthStateFixture builds a live record that expires at the given instant.
func oauthStateFixture(state string, expiresAt time.Time) OAuthState {
	return OAuthState{
		State:          state,
		SiteID:         "site-1",
		Provider:       "google",
		RedirectTarget: "/account/security",
		CodeVerifier:   "verifier-0123456789-0123456789-abcdefghijk",
		CreatedAt:      expiresAt.Add(-10 * time.Minute),
		ExpiresAt:      expiresAt,
	}
}

func TestOAuthStateStoreCreateAndConsume(t *testing.T) {
	store := NewMemoryOAuthStateStore()
	ctx := context.Background()
	record := oauthStateFixture("state-create-consume", time.Now().Add(10*time.Minute))

	if err := store.Create(ctx, record); err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if got := store.Len(); got != 1 {
		t.Fatalf("Len after Create = %d, want 1", got)
	}

	before := time.Now()
	got, err := store.Consume(ctx, record.State)
	after := time.Now()
	if err != nil {
		t.Fatalf("Consume returned error: %v", err)
	}
	if got.State != record.State || got.SiteID != record.SiteID || got.Provider != record.Provider ||
		got.RedirectTarget != record.RedirectTarget || got.CodeVerifier != record.CodeVerifier {
		t.Fatalf("Consume returned %+v, want fields of %+v", got, record)
	}
	if !got.CreatedAt.Equal(record.CreatedAt) || !got.ExpiresAt.Equal(record.ExpiresAt) {
		t.Fatalf("Consume returned timestamps %v/%v, want %v/%v", got.CreatedAt, got.ExpiresAt, record.CreatedAt, record.ExpiresAt)
	}
	if got.ConsumedAt == nil {
		t.Fatal("Consume left ConsumedAt nil, want the redemption time")
	}
	if got.ConsumedAt.Before(before) || got.ConsumedAt.After(after) {
		t.Fatalf("ConsumedAt = %v, want within [%v, %v]", got.ConsumedAt, before, after)
	}
}

func TestOAuthStateStoreCreateRejectsDuplicate(t *testing.T) {
	store := NewMemoryOAuthStateStore()
	ctx := context.Background()
	first := oauthStateFixture("state-duplicate", time.Now().Add(10*time.Minute))
	mustCreateOAuthState(t, store, first)

	second := first
	second.SiteID = "site-2"
	err := store.Create(ctx, second)
	if !errors.Is(err, ErrOAuthStateInvalid) {
		t.Fatalf("duplicate Create error = %v, want ErrOAuthStateInvalid", err)
	}
	if got := store.Len(); got != 1 {
		t.Fatalf("Len after duplicate Create = %d, want 1", got)
	}

	// The original record must survive untouched: the rejected attempt must not
	// be able to redirect the first flow to another site.
	got, err := store.Consume(ctx, first.State)
	if err != nil {
		t.Fatalf("Consume of original returned error: %v", err)
	}
	if got.SiteID != first.SiteID {
		t.Fatalf("stored SiteID = %q, want %q", got.SiteID, first.SiteID)
	}
}

func TestOAuthStateStoreCreateRejectsEmptyState(t *testing.T) {
	store := NewMemoryOAuthStateStore()
	if err := store.Create(context.Background(), OAuthState{}); !errors.Is(err, ErrOAuthStateInvalid) {
		t.Fatalf("Create(empty state) error = %v, want ErrOAuthStateInvalid", err)
	}
	if got := store.Len(); got != 0 {
		t.Fatalf("Len = %d, want 0", got)
	}
}

func TestOAuthStateStoreConsumeOnce(t *testing.T) {
	store := NewMemoryOAuthStateStore()
	ctx := context.Background()
	record := oauthStateFixture("state-once", time.Now().Add(10*time.Minute))
	mustCreateOAuthState(t, store, record)

	first, err := store.Consume(ctx, record.State)
	if err != nil {
		t.Fatalf("first Consume returned error: %v", err)
	}
	if first.ConsumedAt == nil {
		t.Fatal("first Consume left ConsumedAt nil")
	}

	second, err := store.Consume(ctx, record.State)
	if !errors.Is(err, ErrOAuthStateInvalid) {
		t.Fatalf("second Consume error = %v, want ErrOAuthStateInvalid", err)
	}
	if second.State != "" || second.ConsumedAt != nil {
		t.Fatalf("second Consume returned %+v, want zero OAuthState", second)
	}
	// A rejected replay must not move the recorded redemption time.
	stored, err := store.Consume(ctx, record.State)
	if !errors.Is(err, ErrOAuthStateInvalid) || stored.ConsumedAt != nil {
		t.Fatalf("third Consume = (%+v, %v), want (zero, ErrOAuthStateInvalid)", stored, err)
	}
}

func TestOAuthStateStoreConsumeUnknown(t *testing.T) {
	store := NewMemoryOAuthStateStore()
	got, err := store.Consume(context.Background(), "state-never-created")
	if !errors.Is(err, ErrOAuthStateInvalid) {
		t.Fatalf("Consume(unknown) error = %v, want ErrOAuthStateInvalid", err)
	}
	if got.State != "" || got.ConsumedAt != nil {
		t.Fatalf("Consume(unknown) returned %+v, want zero OAuthState", got)
	}
	if n := store.Len(); n != 0 {
		t.Fatalf("Len = %d, want 0", n)
	}
}

func TestOAuthStateStoreConsumeExpired(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name      string
		expiresAt time.Time
	}{
		{name: "expired in the past", expiresAt: now.Add(-time.Minute)},
		{name: "expires exactly now", expiresAt: now},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := NewMemoryOAuthStateStore()
			store.now = func() time.Time { return now }
			record := oauthStateFixture("state-expired", tc.expiresAt)
			mustCreateOAuthState(t, store, record)

			got, err := store.Consume(ctx, record.State)
			if !errors.Is(err, ErrOAuthStateInvalid) {
				t.Fatalf("Consume(expired) error = %v, want ErrOAuthStateInvalid", err)
			}
			if got.ConsumedAt != nil {
				t.Fatalf("Consume(expired) set ConsumedAt = %v, want nil", got.ConsumedAt)
			}
			// Expiry must not be confused with consumption: the record stays until
			// DeleteExpired sweeps it.
			if n := store.Len(); n != 1 {
				t.Fatalf("Len = %d, want 1", n)
			}
		})
	}
}

func TestOAuthStateStoreConsumeAcceptsRecordJustBeforeExpiry(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	store := NewMemoryOAuthStateStore()
	store.now = func() time.Time { return now.Add(-time.Nanosecond) }
	record := oauthStateFixture("state-live", now)
	mustCreateOAuthState(t, store, record)

	if _, err := store.Consume(ctx, record.State); err != nil {
		t.Fatalf("Consume just before expiry returned error: %v", err)
	}
}

func TestOAuthStateStoreDeleteExpired(t *testing.T) {
	ctx := context.Background()
	now := time.Now()

	store := NewMemoryOAuthStateStore()
	expiredFast := oauthStateFixture("state-expired-fast", now.Add(-5*time.Minute))
	expiredSlow := oauthStateFixture("state-expired-slow", now.Add(-time.Second))
	live := oauthStateFixture("state-live", now.Add(5*time.Minute))
	mustCreateOAuthState(t, store, expiredFast)
	mustCreateOAuthState(t, store, expiredSlow)
	mustCreateOAuthState(t, store, live)
	if n := store.Len(); n != 3 {
		t.Fatalf("Len before DeleteExpired = %d, want 3", n)
	}

	if err := store.DeleteExpired(ctx, now); err != nil {
		t.Fatalf("DeleteExpired returned error: %v", err)
	}
	if n := store.Len(); n != 1 {
		t.Fatalf("Len after DeleteExpired = %d, want 1", n)
	}
	for _, state := range []string{expiredFast.State, expiredSlow.State} {
		if _, err := store.Consume(ctx, state); !errors.Is(err, ErrOAuthStateInvalid) {
			t.Fatalf("Consume(%q) after DeleteExpired error = %v, want ErrOAuthStateInvalid", state, err)
		}
	}
	if _, err := store.Consume(ctx, live.State); err != nil {
		t.Fatalf("Consume(live) after DeleteExpired returned error: %v", err)
	}

	// Everything ages out: the count reaches zero.
	if err := store.DeleteExpired(ctx, now.Add(time.Hour)); err != nil {
		t.Fatalf("second DeleteExpired returned error: %v", err)
	}
	if n := store.Len(); n != 0 {
		t.Fatalf("Len after sweeping all = %d, want 0", n)
	}
}

func TestOAuthStateStoreConcurrentConsumeHasOneWinner(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryOAuthStateStore()
	record := oauthStateFixture("state-race", time.Now().Add(10*time.Minute))
	mustCreateOAuthState(t, store, record)

	const callers = 16
	var (
		wg        sync.WaitGroup
		mu        sync.Mutex
		successes int
		failures  int
	)
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := store.Consume(ctx, record.State)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				successes++
			case errors.Is(err, ErrOAuthStateInvalid):
				failures++
			default:
				t.Errorf("Consume returned unexpected error: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()

	if successes != 1 {
		t.Fatalf("successful Consume calls = %d, want exactly 1", successes)
	}
	if failures != callers-1 {
		t.Fatalf("rejected Consume calls = %d, want %d", failures, callers-1)
	}
}

// isRFC7636Unreserved reports whether r is in the unreserved set RFC 7636
// section 4.1 allows in a code verifier.
func isRFC7636Unreserved(r rune) bool {
	switch {
	case r >= 'A' && r <= 'Z':
		return true
	case r >= 'a' && r <= 'z':
		return true
	case r >= '0' && r <= '9':
		return true
	case r == '-', r == '.', r == '_', r == '~':
		return true
	}
	return false
}

func TestNewOAuthState(t *testing.T) {
	ttl := 15 * time.Minute
	before := time.Now()
	state, err := NewOAuthState("site-1", "github", "/settings/connections", ttl)
	after := time.Now()
	if err != nil {
		t.Fatalf("NewOAuthState returned error: %v", err)
	}

	if state.SiteID != "site-1" || state.Provider != "github" || state.RedirectTarget != "/settings/connections" {
		t.Fatalf("NewOAuthState returned %+v, want the arguments copied through", state)
	}
	if state.ConsumedAt != nil {
		t.Fatalf("new state has ConsumedAt = %v, want nil", state.ConsumedAt)
	}
	if state.CreatedAt.Before(before) || state.CreatedAt.After(after) {
		t.Fatalf("CreatedAt = %v, want within [%v, %v]", state.CreatedAt, before, after)
	}
	if got := state.ExpiresAt.Sub(state.CreatedAt); got != ttl {
		t.Fatalf("ExpiresAt-CreatedAt = %v, want %v", got, ttl)
	}

	// The state token must decode back to 32 bytes of entropy, unpadded base64url.
	stateBytes, err := base64.RawURLEncoding.DecodeString(state.State)
	if err != nil {
		t.Fatalf("state is not raw base64url: %v", err)
	}
	if len(stateBytes) != oauthStateBytes {
		t.Fatalf("state decodes to %d bytes, want %d", len(stateBytes), oauthStateBytes)
	}

	// The verifier must satisfy RFC 7636: 43-128 unreserved characters.
	if n := len(state.CodeVerifier); n < 43 || n > 128 {
		t.Fatalf("code verifier length = %d, want 43..128", n)
	}
	for _, r := range state.CodeVerifier {
		if !isRFC7636Unreserved(r) {
			t.Fatalf("code verifier contains %q, which RFC 7636 does not allow", r)
		}
	}
	verifierBytes, err := base64.RawURLEncoding.DecodeString(state.CodeVerifier)
	if err != nil {
		t.Fatalf("code verifier is not raw base64url: %v", err)
	}
	if len(verifierBytes) != pkceVerifierBytes {
		t.Fatalf("code verifier decodes to %d bytes, want %d", len(verifierBytes), pkceVerifierBytes)
	}
	if state.State == state.CodeVerifier {
		t.Fatal("state and code verifier are identical, want independent draws")
	}
}

func TestNewOAuthStateIsUniquePerCall(t *testing.T) {
	const calls = 8
	seenStates := make(map[string]bool, calls)
	seenVerifiers := make(map[string]bool, calls)
	for i := 0; i < calls; i++ {
		state, err := NewOAuthState("site-1", "google", "/", time.Minute)
		if err != nil {
			t.Fatalf("call %d: NewOAuthState returned error: %v", i, err)
		}
		if seenStates[state.State] {
			t.Fatalf("call %d: duplicate state %q", i, state.State)
		}
		if seenVerifiers[state.CodeVerifier] {
			t.Fatalf("call %d: duplicate code verifier %q", i, state.CodeVerifier)
		}
		seenStates[state.State] = true
		seenVerifiers[state.CodeVerifier] = true
	}
}

func TestNewOAuthStateRoundTripsThroughStore(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryOAuthStateStore()
	state, err := NewOAuthState("site-9", "google", "/home", 5*time.Minute)
	if err != nil {
		t.Fatalf("NewOAuthState returned error: %v", err)
	}
	if err := store.Create(ctx, state); err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	got, err := store.Consume(ctx, state.State)
	if err != nil {
		t.Fatalf("Consume returned error: %v", err)
	}
	if got.State != state.State || got.CodeVerifier != state.CodeVerifier || got.RedirectTarget != state.RedirectTarget {
		t.Fatalf("Consume returned %+v, want %+v", got, state)
	}
}
