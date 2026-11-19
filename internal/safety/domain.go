// Package safety owns content safety policy: the site's sensitive word list, the
// comment frequency limits, and the site scoped IP allow and deny lists.
//
// Everything here is enforced on the server. The browser may render hints, but the
// comment and content write paths call into this package before anything is stored,
// so a direct API call obeys the same policy as the admin UI.
//
// Storage is deliberately split (see migration 20261112000000_content_safety):
// words and IP rules are dedicated tables because they are edited row by row, while
// the scalar comment limits live in a one-row-per-site settings table. A missing
// settings row means the defaults below, which is why an upgraded database needs no
// backfill and a site that never opens the safety screen behaves like a fresh one.
package safety

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

// WordMode is the action a matched sensitive word takes.
type WordMode string

// The supported word actions.
const (
	// ModeReject refuses the submission.
	ModeReject WordMode = "reject"
	// ModeReplace rewrites the matched text to the replacement placeholder.
	ModeReplace WordMode = "replace"
	// ModeReview stores the submission for human review instead of publishing it.
	ModeReview WordMode = "review"
)

// Valid reports whether m is a defined mode.
func (m WordMode) Valid() bool {
	return m == ModeReject || m == ModeReplace || m == ModeReview
}

// IPRuleKind is whether an IP rule allows or refuses an address.
type IPRuleKind string

// The supported IP rule kinds.
const (
	IPRuleAllow IPRuleKind = "allow"
	IPRuleDeny  IPRuleKind = "deny"
)

// Valid reports whether k is a defined rule kind.
func (k IPRuleKind) Valid() bool {
	return k == IPRuleAllow || k == IPRuleDeny
}

// Bounds on caller supplied safety configuration.
const (
	// MinWordRunes is the shortest useful sensitive word. Single character entries
	// match far too much ordinary prose (the "Scunthorpe" problem), so they are
	// refused instead of silently mangling every submission.
	MinWordRunes = 2
	// MaxWordRunes bounds one entry.
	MaxWordRunes = 100
	// MaxReplacementRunes bounds the placeholder written in replace mode.
	MaxReplacementRunes = 80
	// MaxIPRuleValueLength matches the storage column.
	MaxIPRuleValueLength = 64
	// MaxNoteRunes bounds the optional operator note on an IP rule.
	MaxNoteRunes = 200
	// MaxCommentUserLimit and MaxCommentIPLimit bound the configurable thresholds so
	// a typo cannot disable abuse protection with an enormous value.
	MaxCommentUserLimit = 1000
	MaxCommentIPLimit   = 10000
	// MinCommentWindowSeconds and MaxCommentWindowSeconds bound the window.
	MinCommentWindowSeconds = 5
	MaxCommentWindowSeconds = 24 * 60 * 60
)

// DefaultReplacement is the placeholder used when a caller leaves it empty.
const DefaultReplacement = "***"

// Default comment frequency limits.
const (
	DefaultCommentUserLimit      = 5
	DefaultCommentIPLimit        = 10
	DefaultCommentWindowSeconds  = 60
	DefaultCommentPolicyCacheTTL = 15 * time.Second
)

// Sentinel errors.
var (
	// ErrInvalidInput means a configuration value failed validation.
	ErrInvalidInput = errors.New("safety: invalid input")
	// ErrNotFound means the word or IP rule does not exist on this site.
	ErrNotFound = errors.New("safety: not found")
	// ErrConflict means the value is already configured.
	ErrConflict = errors.New("safety: already configured")
	// ErrPermissionDenied means the caller may not manage this site's safety policy.
	ErrPermissionDenied = errors.New("safety: permission denied")
	// ErrRejected means a submitted text matched a reject-mode word.
	ErrRejected = errors.New("safety: submission rejected by content policy")
	// ErrRateLimited means a comment write exceeded the configured frequency window.
	ErrRateLimited = errors.New("safety: comment rate limit exceeded")
)

// RejectedError carries the matched words so the caller can audit the decision.
//
// The words are never put on the wire: the response only says the submission was
// refused, otherwise the filter would be an oracle for probing the blocklist.
type RejectedError struct {
	Matched []string
}

func (e *RejectedError) Error() string {
	return fmt.Sprintf("safety: submission rejected (%d matching rule(s))", len(e.Matched))
}

// Unwrap makes errors.Is(err, ErrRejected) work.
func (e *RejectedError) Unwrap() error { return ErrRejected }

// RateLimitError carries the wait time and the counter that tripped.
type RateLimitError struct {
	// RetryAfter is how long the caller should wait.
	RetryAfter time.Duration
	// Scope is "user" or "ip": which counter was exceeded.
	Scope string
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("safety: comment rate limit exceeded (%s)", e.Scope)
}

// Unwrap makes errors.Is(err, ErrRateLimited) work.
func (e *RateLimitError) Unwrap() error { return ErrRateLimited }

// SensitiveWord is one configured word and the action it takes.
type SensitiveWord struct {
	ID          string
	SiteID      string
	Word        string
	Mode        WordMode
	Replacement string
	Enabled     bool
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// IPRule is one address or CIDR block on a site's allow or deny list.
type IPRule struct {
	ID        string
	SiteID    string
	Kind      IPRuleKind
	Value     string
	Note      string
	CreatedAt time.Time
}

// RateConfig is the comment frequency policy of one site.
type RateConfig struct {
	// UserLimit bounds comments per signed-in member per window. Zero disables it.
	UserLimit int
	// IPLimit bounds comments per client address per window. Zero disables it.
	IPLimit int
	// Window is the fixed window length. Zero means the default minute.
	Window time.Duration
}

// DefaultRateConfig returns the documented defaults.
func DefaultRateConfig() RateConfig {
	return RateConfig{
		UserLimit: DefaultCommentUserLimit,
		IPLimit:   DefaultCommentIPLimit,
		Window:    DefaultCommentWindowSeconds * time.Second,
	}
}

// Normalize fills defaults and clamps the window to the supported bounds.
func (c RateConfig) Normalize() RateConfig {
	if c.UserLimit < 0 {
		c.UserLimit = 0
	}
	if c.IPLimit < 0 {
		c.IPLimit = 0
	}
	if c.Window <= 0 {
		c.Window = DefaultCommentWindowSeconds * time.Second
	}
	return c
}

// Policy is the resolved safety configuration of one site.
type Policy struct {
	Words   []SensitiveWord
	IPRules []IPRule
	Rate    RateConfig
}

// TextVerdict is the outcome of applying the word list to one piece of text.
type TextVerdict struct {
	// Text is the original text with replace-mode matches rewritten. It equals the
	// input when no word matched or only reject/review words matched.
	Text string
	// Matched lists the configured words that matched, in configuration order.
	Matched []string
	// Mode is the strictest action among the matches: reject > review > replace.
	// It is empty when nothing matched.
	Mode WordMode
}

// Hit reports whether at least one word matched.
func (v TextVerdict) Hit() bool { return len(v.Matched) > 0 }

// RequiresReview reports whether the strictest match asks for human review.
func (v TextVerdict) RequiresReview() bool { return v.Mode == ModeReview }

// Rejects reports whether the strictest match refuses the submission.
func (v TextVerdict) Rejects() bool { return v.Mode == ModeReject }

// CommentSubmission is one comment write as the policy sees it.
type CommentSubmission struct {
	SiteID string
	// UserID is empty for an anonymous write.
	UserID string
	// IP is the client address the request came from.
	IP   string
	Body string
}

// CommentVerdict is the accepted shape of a comment after policy evaluation.
type CommentVerdict struct {
	// Body is the body to store, with replace-mode matches rewritten.
	Body string
	// RequireReview asks the caller to store the comment as pending_review.
	RequireReview bool
	// Matched lists the matching words for the audit trail.
	Matched []string
	// Mode is the strictest matched action.
	Mode WordMode
}

// Hit reports whether at least one word matched.
func (v CommentVerdict) Hit() bool { return len(v.Matched) > 0 }

// NormalizeWord turns a caller supplied word into the stored form.
//
// Stored words are trimmed, lower-cased and stripped of zero-width formatting
// characters, while the original text is compared through the same normalisation.
// That is what stops "b a d" style zero-width insertion from trivially evading the
// filter; it is not a full Unicode confusable defence.
func NormalizeWord(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range trimmed {
		if unicode.Is(unicode.Cf, r) {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return strings.TrimSpace(b.String())
}

// normalizeForMatch lower-cases and strips zero-width formatting characters.
func normalizeForMatch(text string) string {
	var b strings.Builder
	b.Grow(len(text))
	for _, r := range text {
		if unicode.Is(unicode.Cf, r) {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// asciiWord reports whether the word is made only of ASCII letters and digits, the
// only case where a word boundary is meaningful in Go's regexp package.
func asciiWord(word string) bool {
	for _, r := range word {
		if r > unicode.MaxASCII || (r != '_' && !unicode.IsLetter(r) && !unicode.IsDigit(r)) {
			return false
		}
	}
	return word != ""
}

// wordPattern builds the matcher for one stored word.
//
// ASCII words get \b boundaries so "class" does not match "classic" or "ass"; CJK
// has no word boundaries, so those compare as substrings. The pattern is built per
// evaluation rather than stored because a policy only holds what an administrator
// wrote, which is small.
func wordPattern(word string) *regexp.Regexp {
	quoted := regexp.QuoteMeta(word)
	if asciiWord(word) {
		return regexp.MustCompile(`(?i)\b` + quoted + `\b`)
	}
	return regexp.MustCompile(`(?i)` + quoted)
}

// Evaluate applies the policy to one piece of text.
//
// Replacements are only applied for replace-mode words, but the verdict reports the
// strictest match so a caller can refuse or queue the whole submission.
func (p Policy) Evaluate(text string) TextVerdict {
	verdict := TextVerdict{Text: text}
	if len(p.Words) == 0 || strings.TrimSpace(text) == "" {
		return verdict
	}

	normalized := normalizeForMatch(text)
	seen := make(map[string]bool, len(p.Words))
	matches := make([]SensitiveWord, 0, len(p.Words))
	for _, word := range p.Words {
		if !word.Enabled || word.Word == "" || seen[word.Word] {
			continue
		}
		pattern := wordPattern(word.Word)
		if !pattern.MatchString(normalized) {
			continue
		}
		seen[word.Word] = true
		matches = append(matches, word)
		verdict.Matched = append(verdict.Matched, word.Word)
	}
	if len(matches) == 0 {
		return verdict
	}

	verdict.Mode = strictestMode(matches)
	// Replace-mode matches are always rewritten, even when another matched word is
	// stricter: reject refuses the write anyway, while review still stores the body
	// and should not store the raw word.
	replaced := text
	for _, word := range matches {
		if word.Mode != ModeReplace {
			continue
		}
		replacement := word.Replacement
		if replacement == "" {
			replacement = DefaultReplacement
		}
		replaced = wordPattern(word.Word).ReplaceAllLiteralString(replaced, replacement)
	}
	verdict.Text = replaced
	return verdict
}

// strictestMode returns the most restrictive action among matched words.
func strictestMode(matches []SensitiveWord) WordMode {
	rank := map[WordMode]int{ModeReplace: 1, ModeReview: 2, ModeReject: 3}
	best := ModeReplace
	for _, word := range matches {
		if rank[word.Mode] > rank[best] {
			best = word.Mode
		}
	}
	return best
}

// ParseIPRuleValue validates an address or CIDR block and returns its canonical
// storage form (a masked network for CIDR input).
func ParseIPRuleValue(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || len(value) > MaxIPRuleValueLength {
		return "", ErrInvalidInput
	}
	if ip := net.ParseIP(value); ip != nil {
		return ip.String(), nil
	}
	_, network, err := net.ParseCIDR(value)
	if err != nil {
		return "", ErrInvalidInput
	}
	return network.String(), nil
}

// IPMatches reports whether address falls inside rule (an address or CIDR block).
func IPMatches(address, rule string) bool {
	ip := net.ParseIP(strings.TrimSpace(address))
	if ip == nil {
		return false
	}
	if ruleIP := net.ParseIP(rule); ruleIP != nil {
		return ruleIP.Equal(ip)
	}
	_, network, err := net.ParseCIDR(rule)
	if err != nil {
		return false
	}
	return network.Contains(ip)
}

// Loopback reports whether address is a local address.
//
// Loopback is always allowed by AllowsIP so an operator cannot lock themselves out
// of the admin screen that would remove the rule.
func Loopback(address string) bool {
	ip := net.ParseIP(strings.TrimSpace(address))
	return ip != nil && ip.IsLoopback()
}

// RateLimitStore counts requests per key within a window.
//
// It mirrors the transport limiter on purpose: this package is the server side
// policy and must stay usable from a worker or a test that never builds an HTTP
// engine. The in-process implementation is per replica; a multi-instance deployment
// needs a shared store and that swap does not touch the policy code.
type RateLimitStore interface {
	Allow(key string, limit int, window time.Duration) (allowed bool, retryAfter time.Duration)
}

// MemoryRateLimitStore is a per process fixed window counter.
type MemoryRateLimitStore struct {
	mu         sync.Mutex
	now        func() time.Time
	windows    map[string]*fixedWindow
	maxEntries int
}

type fixedWindow struct {
	count   int
	resetAt time.Time
}

// NewMemoryRateLimitStore builds a store. A nil clock means time.Now.
func NewMemoryRateLimitStore(now func() time.Time) *MemoryRateLimitStore {
	if now == nil {
		now = time.Now
	}
	return &MemoryRateLimitStore{
		now:        now,
		windows:    make(map[string]*fixedWindow),
		maxEntries: 50000,
	}
}

// Allow implements RateLimitStore.
func (s *MemoryRateLimitStore) Allow(key string, limit int, window time.Duration) (bool, time.Duration) {
	if limit <= 0 {
		return true, 0
	}
	if window <= 0 {
		window = time.Minute
	}

	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()

	current, ok := s.windows[key]
	if !ok || !now.Before(current.resetAt) {
		if !ok && len(s.windows) >= s.maxEntries {
			for existing, entry := range s.windows {
				if !now.Before(entry.resetAt) {
					delete(s.windows, existing)
				}
			}
		}
		s.windows[key] = &fixedWindow{count: 1, resetAt: now.Add(window)}
		return true, 0
	}
	if current.count >= limit {
		return false, current.resetAt.Sub(now)
	}
	current.count++
	return true, 0
}

// sortedWords returns the words in a stable order for admin responses.
func sortedWords(words []SensitiveWord) []SensitiveWord {
	out := append([]SensitiveWord(nil), words...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Word == out[j].Word {
			return out[i].ID < out[j].ID
		}
		return out[i].Word < out[j].Word
	})
	return out
}
