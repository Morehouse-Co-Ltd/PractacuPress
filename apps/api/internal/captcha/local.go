package captcha

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"
)

// The local provider is a self-hosted alternative to the third party widget
// services: this process asks a small arithmetic question and remembers the answer
// for a couple of minutes. It exists for deployments that cannot depend on an
// external CDN or an operator-supplied secret (offline, intranet, privacy-first),
// and it is deliberately modest: it stops naive scripted sign-ups, not a determined
// human or a captcha farm.
//
// The protocol has two public endpoints (see handler.go):
//
//	GET  /api/v1/captcha/local/challenge?scene=...  -> {challenge_id, question, expires_at}
//	POST /api/v1/captcha/local/verify               -> {token, expires_at}
//
// The token is then handed to the protected endpoint exactly like a Turnstile or
// hCaptcha token, and the guard redeems it through the same Verifier path.

const (
	// DefaultLocalChallengeTTL bounds how long a visitor may take to answer a
	// question. It is short because the answer travels only between two requests.
	DefaultLocalChallengeTTL = 2 * time.Minute
	// DefaultLocalTokenTTL is the lifetime of the solved token between the local
	// verify call and the protected request (login, register, ...).
	DefaultLocalTokenTTL = 5 * time.Minute

	// The maps are bounded so a public endpoint cannot grow memory without limit.
	// Reaching the cap evicts the entry that expires first rather than rejecting
	// the visitor: the oldest challenge is the least valuable one.
	localMaxChallenges = 4096
	localMaxTokens     = 4096

	// localSweepInterval throttles the lazy cleanup of expired entries.
	localSweepInterval = 30 * time.Second

	// Operands stay small enough to answer mentally; the answer is a plain integer.
	localOperandMax = 12
)

// LocalChallenge is one issued arithmetic question.
type LocalChallenge struct {
	ID        string    `json:"challenge_id"`
	Question  string    `json:"question"`
	ExpiresAt time.Time `json:"expires_at"`
}

// LocalStore keeps the pending questions and the issued tokens in memory.
//
// One process issues and redeems everything, which is the honest boundary of this
// provider: a multi-instance deployment must route the two local calls (and the
// protected form request) to the same instance, or use a third party provider. The
// status endpoint reports the local provider as effective only when this store is
// wired, so a form never promises a check the deployment cannot run.
type LocalStore struct {
	mu sync.Mutex

	now          func() time.Time
	challengeTTL time.Duration
	tokenTTL     time.Duration

	challenges map[string]localChallenge
	tokens     map[string]localToken
	// used remembers redeemed tokens until they would have expired, so a replay of
	// a solved token is reported as a replay instead of as an unknown token.
	used      map[string]time.Time
	lastSweep time.Time
}

type localChallenge struct {
	answer    int
	scene     Scene
	expiresAt time.Time
}

type localToken struct {
	scene     Scene
	expiresAt time.Time
}

// LocalStoreConfig configures a LocalStore. The zero value is production ready.
type LocalStoreConfig struct {
	// ChallengeTTL bounds a pending question. Zero uses DefaultLocalChallengeTTL.
	ChallengeTTL time.Duration
	// TokenTTL bounds a solved token. Zero uses DefaultLocalTokenTTL.
	TokenTTL time.Duration
	// Now is the clock, for tests.
	Now func() time.Time
}

// NewLocalStore builds an in-memory challenge store.
func NewLocalStore(cfg LocalStoreConfig) *LocalStore {
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	challengeTTL := cfg.ChallengeTTL
	if challengeTTL <= 0 {
		challengeTTL = DefaultLocalChallengeTTL
	}
	tokenTTL := cfg.TokenTTL
	if tokenTTL <= 0 {
		tokenTTL = DefaultLocalTokenTTL
	}
	return &LocalStore{
		now:          now,
		challengeTTL: challengeTTL,
		tokenTTL:     tokenTTL,
		challenges:   make(map[string]localChallenge),
		tokens:       make(map[string]localToken),
		used:         make(map[string]time.Time),
	}
}

// Issue creates one arithmetic question for scene.
func (s *LocalStore) Issue(scene Scene) (LocalChallenge, error) {
	if s == nil {
		return LocalChallenge{}, fmt.Errorf("%w: %s", ErrNotConfigured, ProviderLocal)
	}
	if !scene.Valid() {
		return LocalChallenge{}, ErrSceneUnknown
	}

	operandA, err := randomBelow(localOperandMax)
	if err != nil {
		return LocalChallenge{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	operandB, err := randomBelow(localOperandMax)
	if err != nil {
		return LocalChallenge{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	operandA++
	operandB++
	operation, err := randomBelow(2)
	if err != nil {
		return LocalChallenge{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	question, answer := localQuestion(operandA, operandB, operation)

	id, err := randomID()
	if err != nil {
		return LocalChallenge{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}

	now := s.now()
	expiresAt := now.Add(s.challengeTTL)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(now)
	if len(s.challenges) >= localMaxChallenges {
		s.evictSoonestChallengeLocked()
	}
	s.challenges[id] = localChallenge{answer: answer, scene: scene, expiresAt: expiresAt}

	return LocalChallenge{ID: id, Question: question, ExpiresAt: expiresAt}, nil
}

// Solve checks one answer and, when it is right, mints a token bound to the scene.
//
// The challenge is consumed by the first verify attempt, right or wrong: leaving a
// solved-but-wrong challenge open would let a script brute-force the two digit
// answer range on a single question.
func (s *LocalStore) Solve(challengeID string, answer int, scene Scene) (string, time.Time, error) {
	if s == nil {
		return "", time.Time{}, fmt.Errorf("%w: %s", ErrNotConfigured, ProviderLocal)
	}
	if !scene.Valid() {
		return "", time.Time{}, ErrSceneUnknown
	}
	id := strings.TrimSpace(challengeID)
	if id == "" {
		return "", time.Time{}, ErrTokenMissing
	}

	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(now)

	challenge, ok := s.challenges[id]
	if !ok {
		return "", time.Time{}, fmt.Errorf("%w: local challenge is unknown or already answered", ErrRejected)
	}
	delete(s.challenges, id)
	if now.After(challenge.expiresAt) {
		return "", time.Time{}, fmt.Errorf("%w: local challenge expired", ErrRejected)
	}
	if challenge.scene != scene {
		return "", time.Time{}, fmt.Errorf(
			"%w: local challenge for %q submitted to %q",
			ErrActionMismatch, challenge.scene, scene,
		)
	}
	if answer != challenge.answer {
		return "", time.Time{}, fmt.Errorf("%w: local challenge answer was wrong", ErrRejected)
	}

	token, err := randomID()
	if err != nil {
		return "", time.Time{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	expiresAt := now.Add(s.tokenTTL)
	if len(s.tokens) >= localMaxTokens {
		s.evictSoonestTokenLocked()
	}
	s.tokens[token] = localToken{scene: scene, expiresAt: expiresAt}
	return token, expiresAt, nil
}

// Redeem consumes a solved token for scene.
//
// It returns ErrReplay when a token was already spent and ErrActionMismatch when a
// valid token was submitted to another protected form. Errors are the same
// sentinels the third party verifier produces, so the handler layer does not need a
// local-only vocabulary.
func (s *LocalStore) Redeem(token string, scene Scene) (Result, error) {
	if s == nil {
		return Result{}, fmt.Errorf("%w: %s", ErrNotConfigured, ProviderLocal)
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return Result{}, ErrTokenMissing
	}
	if !scene.Valid() {
		return Result{}, ErrSceneUnknown
	}

	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(now)

	if expiresAt, spent := s.used[token]; spent {
		if now.Before(expiresAt) {
			return Result{}, fmt.Errorf("%w: %s token was already redeemed", ErrReplay, ProviderLocal)
		}
		delete(s.used, token)
	}
	stored, ok := s.tokens[token]
	if !ok {
		return Result{}, fmt.Errorf("%w: %s token is unknown", ErrRejected, ProviderLocal)
	}
	if now.After(stored.expiresAt) {
		delete(s.tokens, token)
		return Result{}, fmt.Errorf("%w: %s token expired", ErrRejected, ProviderLocal)
	}
	if stored.scene != scene {
		return Result{}, fmt.Errorf(
			"%w: %s token for %q submitted to %q",
			ErrActionMismatch, ProviderLocal, stored.scene, scene,
		)
	}

	// Redeeming is the moment the token stops being usable: a second call, even by a
	// second request that raced this one, finds it in used.
	delete(s.tokens, token)
	s.used[token] = stored.expiresAt
	if len(s.used) >= localMaxTokens {
		s.evictSoonestUsedLocked()
	}
	return Result{Provider: ProviderLocal, CheckedAt: now}, nil
}

// sweepLocked drops expired entries. It is lazy and throttled: no background
// goroutine means nothing to stop at process shutdown, and the maps are small.
func (s *LocalStore) sweepLocked(now time.Time) {
	if now.Sub(s.lastSweep) < localSweepInterval {
		return
	}
	s.lastSweep = now
	for id, challenge := range s.challenges {
		if now.After(challenge.expiresAt) {
			delete(s.challenges, id)
		}
	}
	for token, stored := range s.tokens {
		if now.After(stored.expiresAt) {
			delete(s.tokens, token)
		}
	}
	for token, expiresAt := range s.used {
		if now.After(expiresAt) {
			delete(s.used, token)
		}
	}
}

// evictSoonestChallengeLocked makes room by dropping the challenge that expires
// first. A visitor who lost that one can simply ask for another question.
func (s *LocalStore) evictSoonestChallengeLocked() {
	var soonestID string
	var soonest time.Time
	for id, challenge := range s.challenges {
		if soonestID == "" || challenge.expiresAt.Before(soonest) {
			soonestID, soonest = id, challenge.expiresAt
		}
	}
	if soonestID != "" {
		delete(s.challenges, soonestID)
	}
}

// evictSoonestTokenLocked makes room by dropping the token that expires first.
func (s *LocalStore) evictSoonestTokenLocked() {
	var soonestToken string
	var soonest time.Time
	for token, stored := range s.tokens {
		if soonestToken == "" || stored.expiresAt.Before(soonest) {
			soonestToken, soonest = token, stored.expiresAt
		}
	}
	if soonestToken != "" {
		delete(s.tokens, soonestToken)
	}
}

// evictSoonestUsedLocked bounds the replay memory the same way as the live tokens.
// Forgetting a spent token earlier than its expiry only widens the unknown-token
// branch, which is still a rejection.
func (s *LocalStore) evictSoonestUsedLocked() {
	var soonestToken string
	var soonest time.Time
	for token, expiresAt := range s.used {
		if soonestToken == "" || expiresAt.Before(soonest) {
			soonestToken, soonest = token, expiresAt
		}
	}
	if soonestToken != "" {
		delete(s.used, soonestToken)
	}
}

// localQuestion renders the question text and its expected integer answer.
func localQuestion(operandA, operandB, operation int) (string, int) {
	if operation == 0 {
		return fmt.Sprintf("%d + %d = ?", operandA, operandB), operandA + operandB
	}
	// Subtraction keeps the subtrahend at most the minuend so the answer is never
	// negative (a visitor typing "-2" is a UX trap, not a harder check).
	if operandB > operandA {
		operandA, operandB = operandB, operandA
	}
	return fmt.Sprintf("%d - %d = ?", operandA, operandB), operandA - operandB
}

// randomBelow returns a uniformly random integer in [0, max).
func randomBelow(max int) (int, error) {
	if max <= 0 {
		return 0, fmt.Errorf("local challenge: invalid range %d", max)
	}
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return 0, err
	}
	return int(binary.BigEndian.Uint64(buf[:]) % uint64(max)), nil
}

// randomID returns 128 random bits as hex. It is long enough that guessing a
// challenge id or a token is not a strategy for a script.
func randomID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}
