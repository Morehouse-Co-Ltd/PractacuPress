package captcha

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"
)

// The local provider is a self-hosted alternative to the third party widget
// services: this process draws a small picture challenge (slider, click or
// select) and remembers the expected answer for a couple of minutes. It exists
// for deployments that cannot depend on an external CDN or an operator-supplied
// secret (offline, intranet, privacy-first), and it is deliberately modest: it
// stops naive scripted sign-ups, not a determined human or a captcha farm.
//
// The protocol has two public endpoints (see handler.go):
//
//	GET  /api/v1/captcha/local/challenge?scene=...  -> picture + geometry
//	POST /api/v1/captcha/local/verify               -> {token, expires_at}
//
// The token is then handed to the protected endpoint exactly like a Turnstile or
// hCaptcha token, and the guard redeems it through the same Verifier path.

const (
	// DefaultLocalChallengeTTL bounds how long a visitor may take to answer a
	// challenge. It is short because the answer travels only between two requests.
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
)

// LocalKind names one of the challenge interactions the local provider rotates.
type LocalKind string

// The challenge kinds, in the order the provider rotates them.
const (
	LocalKindSlider LocalKind = "slider"
	LocalKindClick  LocalKind = "click"
	LocalKindSelect LocalKind = "select"
)

// LocalKinds lists every challenge kind. It is exported so tests and clients can
// assert the rotation does not silently shrink to one kind.
var LocalKinds = []LocalKind{LocalKindSlider, LocalKindClick, LocalKindSelect}

// Valid reports whether k is a known challenge kind.
func (k LocalKind) Valid() bool {
	switch k {
	case LocalKindSlider, LocalKindClick, LocalKindSelect:
		return true
	default:
		return false
	}
}

// LocalPoint is a point in the challenge picture's own pixel space.
type LocalPoint struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// LocalAnswer is the visitor's solution. Exactly one field is meaningful,
// depending on the challenge kind:
//
//   - slider: X is the left edge of the piece, in picture pixels;
//   - click:  Points are the clicked coordinates, in picture pixels;
//   - select: Tiles are the selected cell indexes, row-major.
//
// Keeping all three shapes in one struct lets the HTTP layer decode an answer
// before it knows the kind; the store still rejects a shape that does not match
// the issued challenge.
type LocalAnswer struct {
	X      *int         `json:"x,omitempty"`
	Points []LocalPoint `json:"points,omitempty"`
	Tiles  []int        `json:"tiles,omitempty"`
}

// Empty reports whether the answer carries nothing at all. An empty answer is a
// malformed request, not a wrong solution, and the handler reports it as such.
func (a LocalAnswer) Empty() bool {
	return a.X == nil && len(a.Points) == 0 && len(a.Tiles) == 0
}

// LocalChallenge is one issued challenge. It carries everything a browser needs
// to render the task and nothing that reveals the answer.
type LocalChallenge struct {
	ID        string    `json:"challenge_id"`
	Kind      LocalKind `json:"kind"`
	Prompt    string    `json:"prompt"`
	ExpiresAt time.Time `json:"expires_at"`
	// Width and Height are the picture's natural pixel size; click coordinates
	// are submitted in this space even when CSS scales the picture down.
	Width  int `json:"width"`
	Height int `json:"height"`
	// Image is the single picture of the click and select kinds.
	Image string `json:"image,omitempty"`
	// Background and Piece are the slider kind's two pictures.
	Background string `json:"background,omitempty"`
	Piece      string `json:"piece,omitempty"`
	PieceSize  int    `json:"piece_size,omitempty"`
	PieceTop   int    `json:"piece_top,omitempty"`
	// MaxOffset is the largest legal slider X, so the piece cannot leave the
	// picture.
	MaxOffset int `json:"max_offset,omitempty"`
	// TargetCount is how many stars or cells the visitor has to pick.
	TargetCount int `json:"target_count,omitempty"`
	// Rows and Cols describe the select grid.
	Rows int `json:"rows,omitempty"`
	Cols int `json:"cols,omitempty"`
}

// LocalStore keeps the pending challenges and the issued tokens in memory.
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

	// lastKind is the kind of the challenge issued most recently. Consecutive
	// challenges never repeat it, so a bot that recognises one interaction still
	// has to handle the next one. The zero value means "nothing issued yet".
	// Guarded by mu.
	lastKind LocalKind
}

type localChallenge struct {
	kind      LocalKind
	expected  LocalAnswer
	scene     Scene
	expiresAt time.Time
}

type localToken struct {
	scene     Scene
	expiresAt time.Time
}

// LocalStoreConfig configures a LocalStore. The zero value is production ready.
type LocalStoreConfig struct {
	// ChallengeTTL bounds a pending challenge. Zero uses DefaultLocalChallengeTTL.
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

// Issue creates one picture challenge for scene.
func (s *LocalStore) Issue(scene Scene) (LocalChallenge, error) {
	challenge, _, err := s.IssueWithAnswer(scene)
	return challenge, err
}

// IssueWithAnswer issues a challenge and returns the expected answer with it.
//
// The HTTP endpoint uses Issue: the answer must stay in this process. The variant
// exists for in-process callers (tests, smoke checks) that have to mint a token
// without a browser. Treat the returned answer as a secret.
func (s *LocalStore) IssueWithAnswer(scene Scene) (LocalChallenge, LocalAnswer, error) {
	if s == nil {
		return LocalChallenge{}, LocalAnswer{}, fmt.Errorf("%w: %s", ErrNotConfigured, ProviderLocal)
	}
	if !scene.Valid() {
		return LocalChallenge{}, LocalAnswer{}, ErrSceneUnknown
	}

	kind, err := s.nextKind()
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	challenge, answer, err := generateLocalChallenge(kind, scene)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}

	id, err := randomID()
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}

	now := s.now()
	expiresAt := now.Add(s.challengeTTL)
	challenge.ID = id
	challenge.ExpiresAt = expiresAt

	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(now)
	if len(s.challenges) >= localMaxChallenges {
		s.evictSoonestChallengeLocked()
	}
	s.challenges[id] = localChallenge{
		kind:      challenge.Kind,
		expected:  answer,
		scene:     scene,
		expiresAt: expiresAt,
	}

	return challenge, answer, nil
}

// nextKind picks the kind of the next challenge.
//
// Two consecutive challenges never ask for the same interaction: the kind is drawn
// uniformly from the two kinds other than the last one. The pick and the bookkeeping
// happen under the same lock, so concurrent callers cannot interleave into a repeat
// (two visitors issuing at the same moment get two different kinds).
func (s *LocalStore) nextKind() (LocalKind, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	candidates := localKindCandidates(s.lastKind)
	index, err := randomBelow(len(candidates))
	if err != nil {
		return "", err
	}
	kind := candidates[index]
	s.lastKind = kind
	return kind, nil
}

// localKindCandidates lists the kinds a challenge may take after previous. An
// unknown previous value (including the zero value of a fresh store) allows any
// kind, in the advertised rotation order.
func localKindCandidates(previous LocalKind) []LocalKind {
	if !previous.Valid() {
		return LocalKinds
	}
	candidates := make([]LocalKind, 0, len(LocalKinds)-1)
	for _, kind := range LocalKinds {
		if kind != previous {
			candidates = append(candidates, kind)
		}
	}
	return candidates
}

// Solve checks one answer and, when it is right, mints a token bound to the scene.
//
// The challenge is consumed by the first verify attempt, right or wrong: leaving a
// solved-but-wrong challenge open would let a script probe the answer space (a
// slider has only ~220 legal offsets) on a single picture.
func (s *LocalStore) Solve(challengeID string, answer LocalAnswer, scene Scene) (string, time.Time, error) {
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

	stored, ok := s.challenges[id]
	if !ok {
		return "", time.Time{}, fmt.Errorf("%w: local challenge is unknown or already answered", ErrRejected)
	}
	delete(s.challenges, id)
	if now.After(stored.expiresAt) {
		return "", time.Time{}, fmt.Errorf("%w: local challenge expired", ErrRejected)
	}
	if stored.scene != scene {
		return "", time.Time{}, fmt.Errorf(
			"%w: local challenge for %q submitted to %q",
			ErrActionMismatch, stored.scene, scene,
		)
	}
	if !verifyLocalAnswer(stored.kind, stored.expected, answer) {
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

	// Redeeming is the moment the token stops being usable: a second call, even by
	// a second request that raced this one, finds it in used.
	delete(s.tokens, token)
	s.used[token] = stored.expiresAt
	if len(s.used) >= localMaxTokens {
		s.evictSoonestUsedLocked()
	}
	return Result{Provider: ProviderLocal, CheckedAt: now}, nil
}

// verifyLocalAnswer compares a submitted answer with the stored one.
//
// Every comparison is tolerant in pixels, not exact: a visitor's pointer lands
// near the target, and a slider drag reports a rounded offset. The tolerances are
// tight enough that guessing (say, picking three random cells out of nine) is not
// a strategy.
func verifyLocalAnswer(kind LocalKind, expected, got LocalAnswer) bool {
	switch kind {
	case LocalKindSlider:
		if expected.X == nil || got.X == nil {
			return false
		}
		delta := *got.X - *expected.X
		if delta < 0 {
			delta = -delta
		}
		return delta <= localSliderTolerance
	case LocalKindClick:
		if len(expected.Points) == 0 || len(got.Points) != len(expected.Points) {
			return false
		}
		used := make([]bool, len(got.Points))
		tolerance := localClickTolerance * localClickTolerance
		for _, target := range expected.Points {
			matched := false
			for index, point := range got.Points {
				if used[index] {
					continue
				}
				dx := point.X - target.X
				dy := point.Y - target.Y
				if dx*dx+dy*dy <= tolerance {
					used[index] = true
					matched = true
					break
				}
			}
			if !matched {
				return false
			}
		}
		return true
	case LocalKindSelect:
		if len(expected.Tiles) == 0 || len(got.Tiles) != len(expected.Tiles) {
			return false
		}
		wanted := append([]int(nil), expected.Tiles...)
		actual := append([]int(nil), got.Tiles...)
		sort.Ints(wanted)
		sort.Ints(actual)
		for index := range wanted {
			if wanted[index] != actual[index] {
				return false
			}
		}
		return true
	default:
		return false
	}
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
// first. A visitor who lost that one can simply ask for another challenge.
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

// randomBelow returns a uniformly random integer in [0, max).
//
// crypto/rand.Int draws from the bytes modulo-free (it rejection-samples rather
// than taking a remainder), so every value of the range is equally likely. The
// previous implementation reduced a 64-bit word modulo max, which quietly
// favoured the low values whenever max did not divide 2^64.
func randomBelow(max int) (int, error) {
	if max <= 0 {
		return 0, fmt.Errorf("local challenge: invalid range %d", max)
	}
	value, err := rand.Int(rand.Reader, big.NewInt(int64(max)))
	if err != nil {
		return 0, err
	}
	return int(value.Int64()), nil
}

// randBetween returns a uniformly random integer in [min, max].
func randBetween(min, max int) (int, error) {
	if max < min {
		return 0, fmt.Errorf("local challenge: invalid range [%d,%d]", min, max)
	}
	offset, err := randomBelow(max - min + 1)
	if err != nil {
		return 0, err
	}
	return min + offset, nil
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
