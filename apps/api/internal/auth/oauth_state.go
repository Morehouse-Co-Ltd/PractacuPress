package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Third party login state (FSD F-04).
//
// The authorization code flow is server stateful in exactly one place: the login
// attempt in flight between the redirect to the provider and the callback that
// comes back. OAuthState is that record. It carries the CSRF token the callback
// must echo, the site the user started from, the provider the code belongs to,
// where to land afterwards, and the PKCE verifier the token exchange needs.
//
// Consumption is single use by construction: whoever flips ConsumedAt first owns
// the attempt, and every later attempt at the same state is rejected. That is
// what makes a replayed callback harmless.

const (
	// oauthStateBytes is the entropy behind the state token. 32 bytes encode to
	// 43 base64url characters, which is unguessable and short enough for a URL.
	oauthStateBytes = 32
	// pkceVerifierBytes is the entropy behind the PKCE code verifier. 32 bytes
	// encode to 43 base64url characters: the RFC 7636 minimum, inside its 43-128
	// range, and drawn from the unreserved set RFC 7636 requires.
	pkceVerifierBytes = 32
)

// ErrOAuthStateInvalid is returned for every state that cannot be consumed: an
// unknown value, one already used, or one that expired. The cases are
// deliberately indistinguishable to the caller because the distinction only
// helps an attacker probe the store.
var ErrOAuthStateInvalid = errors.New("auth: oauth state is invalid")

// OAuthState is one login attempt awaiting its callback.
//
// SiteID is the site the flow started from, Provider the id the code belongs to
// ("google", "github"), RedirectTarget the in-site path to return to. The
// CodeVerifier is the PKCE secret; it is stored here because the callback
// arrives without it.
type OAuthState struct {
	State          string
	SiteID         string
	Provider       string
	RedirectTarget string
	CodeVerifier   string
	CreatedAt      time.Time
	ExpiresAt      time.Time
	// ConsumedAt is nil until the state is redeemed, and the redemption time
	// afterwards.
	ConsumedAt *time.Time
}

// OAuthStateStore persists in-flight login attempts.
//
// Create must reject a state that already exists rather than overwrite it: an
// overwrite would let a second flow hijack the first one's callback. Consume
// must check and mark in one step so two concurrent callbacks cannot both win.
type OAuthStateStore interface {
	Create(ctx context.Context, s OAuthState) error
	Consume(ctx context.Context, state string) (OAuthState, error)
	DeleteExpired(ctx context.Context, now time.Time) error
}

// MemoryOAuthStateStore is the in-process implementation.
//
// It is per instance rather than global, so tests and multiple API processes
// stay independent. Entries live until they are consumed or cleaned by
// DeleteExpired; a single process holding one record per in-flight login is
// bounded by the number of concurrent logins, not by history.
type MemoryOAuthStateStore struct {
	mu    sync.Mutex
	items map[string]OAuthState
	// now is the clock Consume stamps ConsumedAt with. Tests replace it;
	// production uses time.Now.
	now func() time.Time
}

// NewMemoryOAuthStateStore returns an empty store.
func NewMemoryOAuthStateStore() *MemoryOAuthStateStore {
	return &MemoryOAuthStateStore{
		items: make(map[string]OAuthState),
		now:   time.Now,
	}
}

// Create stores the state. An empty or already present state is refused with
// ErrOAuthStateInvalid.
func (s *MemoryOAuthStateStore) Create(ctx context.Context, st OAuthState) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if st.State == "" {
		return ErrOAuthStateInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.items[st.State]; exists {
		return fmt.Errorf("%w: state already exists", ErrOAuthStateInvalid)
	}
	s.items[st.State] = st
	return nil
}

// Consume redeems a state exactly once.
//
// The existence check, the expiry check, the consumed check and the write of
// ConsumedAt all happen under one lock, so a concurrent second callback either
// sees the attempt already consumed or marks it itself, never both.
func (s *MemoryOAuthStateStore) Consume(ctx context.Context, state string) (OAuthState, error) {
	if err := ctx.Err(); err != nil {
		return OAuthState{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	stored, ok := s.items[state]
	if !ok {
		return OAuthState{}, ErrOAuthStateInvalid
	}
	if stored.ConsumedAt != nil {
		return OAuthState{}, ErrOAuthStateInvalid
	}
	now := s.now()
	if !now.Before(stored.ExpiresAt) {
		return OAuthState{}, ErrOAuthStateInvalid
	}
	consumed := now
	stored.ConsumedAt = &consumed
	s.items[state] = stored
	return stored, nil
}

// DeleteExpired drops every entry whose ExpiresAt is at or before now. A
// consumed entry keeps its place until it expires, so a replayed callback is
// still refused (with the same opaque error) rather than looking unknown.
func (s *MemoryOAuthStateStore) DeleteExpired(ctx context.Context, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for state, stored := range s.items {
		if !now.Before(stored.ExpiresAt) {
			delete(s.items, state)
		}
	}
	return nil
}

// Len reports how many states the store holds. It is for tests and diagnostics;
// it is not part of OAuthStateStore.
func (s *MemoryOAuthStateStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.items)
}

// NewOAuthState mints one login attempt.
//
// State and CodeVerifier are independent 32-byte crypto/rand draws, base64url
// encoded. The verifier's alphabet (A-Z, a-z, 0-9, "-", "_") is a subset of the
// unreserved characters RFC 7636 allows, and its 43 characters sit at the low
// end of the permitted 43-128 range. ExpiresAt is CreatedAt plus ttl.
func NewOAuthState(siteID, provider, redirectTarget string, ttl time.Duration) (OAuthState, error) {
	state, err := randomURLToken(oauthStateBytes)
	if err != nil {
		return OAuthState{}, err
	}
	verifier, err := randomURLToken(pkceVerifierBytes)
	if err != nil {
		return OAuthState{}, err
	}
	now := time.Now()
	return OAuthState{
		State:          state,
		SiteID:         siteID,
		Provider:       provider,
		RedirectTarget: redirectTarget,
		CodeVerifier:   verifier,
		CreatedAt:      now,
		ExpiresAt:      now.Add(ttl),
	}, nil
}

// randomURLToken draws n bytes from crypto/rand and encodes them without
// padding, which keeps the result URL and form safe.
func randomURLToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("auth: generate oauth state material: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
