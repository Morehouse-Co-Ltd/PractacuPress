package safety

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Repository is the persistence contract for content safety configuration.
type Repository interface {
	// ListWords returns every configured word of a site, enabled or not.
	ListWords(ctx context.Context, siteID string) ([]SensitiveWord, error)
	// InsertWord stores a new word. A duplicate spelling answers ErrConflict.
	InsertWord(ctx context.Context, word SensitiveWord) (SensitiveWord, error)
	// FindWord loads one word inside a site scope.
	FindWord(ctx context.Context, siteID, wordID string) (SensitiveWord, error)
	// UpdateWord stores a mode, replacement or enabled change.
	UpdateWord(ctx context.Context, word SensitiveWord) (SensitiveWord, error)
	// DeleteWord removes one word inside a site scope.
	DeleteWord(ctx context.Context, siteID, wordID string) error

	// ListIPRules returns every allow and deny entry of a site.
	ListIPRules(ctx context.Context, siteID string) ([]IPRule, error)
	// InsertIPRule stores a new rule. A duplicate triple answers ErrConflict.
	InsertIPRule(ctx context.Context, rule IPRule) (IPRule, error)
	// FindIPRule loads one rule inside a site scope.
	FindIPRule(ctx context.Context, siteID, ruleID string) (IPRule, error)
	// DeleteIPRule removes one rule inside a site scope.
	DeleteIPRule(ctx context.Context, siteID, ruleID string) error

	// RateConfig returns the site limits, or ErrNotFound when the site still uses
	// the documented defaults.
	RateConfig(ctx context.Context, siteID string) (RateConfig, error)
	// SaveRateConfig upserts the limits of one site.
	SaveRateConfig(ctx context.Context, siteID string, cfg RateConfig, at time.Time) error
}

// Actor is the caller managing a site's safety policy.
type Actor struct {
	UserID string
	SiteID string
	Role   site.Role
}

// WordInput creates one sensitive word.
type WordInput struct {
	Word        string
	Mode        WordMode
	Replacement string
	Enabled     *bool
}

// WordUpdate changes an existing word. The word itself is immutable: renaming is a
// delete plus a create, which keeps the unique key and the audit trail honest.
type WordUpdate struct {
	Mode        *WordMode
	Replacement *string
	Enabled     *bool
}

// IPRuleInput creates one allow or deny entry.
type IPRuleInput struct {
	Kind  IPRuleKind
	Value string
	Note  string
}

// RateLimitInput is a partial update of the comment frequency limits.
type RateLimitInput struct {
	UserLimit     *int
	IPLimit       *int
	WindowSeconds *int
}

// Option customises a Service.
type Option func(*Service)

// WithAudit records privileged changes in the site audit trail.
//
// Recording is best effort: the configuration change is already committed when it
// runs, and a write failure must not turn a successful save into an API error.
func WithAudit(recorder audit.Recorder) Option {
	return func(s *Service) { s.audit = recorder }
}

// WithClock replaces the clock, for tests.
func WithClock(now func() time.Time) Option {
	return func(s *Service) {
		if now != nil {
			s.now = now
		}
	}
}

// WithLimitStore installs the counter store used by the comment rate limiter.
func WithLimitStore(store RateLimitStore) Option {
	return func(s *Service) {
		if store != nil {
			s.limiter = store
		}
	}
}

// WithCacheTTL sets how long a resolved policy is cached.
//
// A non positive value disables caching. The cache is per process; every mutation
// through this service invalidates the entry immediately, while another replica sees
// the change after at most this TTL.
func WithCacheTTL(ttl time.Duration) Option {
	return func(s *Service) { s.cacheTTL = ttl }
}

// Service implements content safety policy and its administration.
type Service struct {
	repo     Repository
	audit    audit.Recorder
	limiter  RateLimitStore
	now      func() time.Time
	cacheTTL time.Duration

	mu    sync.RWMutex
	cache map[string]policyCacheEntry
}

type policyCacheEntry struct {
	policy  Policy
	expires time.Time
}

// NewService builds a Service.
func NewService(repo Repository, options ...Option) (*Service, error) {
	if repo == nil {
		return nil, errors.New("safety: repository is required")
	}
	service := &Service{
		repo:     repo,
		now:      func() time.Time { return time.Now().UTC() },
		cacheTTL: DefaultCommentPolicyCacheTTL,
		cache:    make(map[string]policyCacheEntry),
	}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	if service.limiter == nil {
		// Build the default after the options so an injected clock is honoured by the
		// fixed window counters too.
		service.limiter = NewMemoryRateLimitStore(service.now)
	}
	return service, nil
}

// Policy returns the full configuration of a site for the admin screen.
func (s *Service) Policy(ctx context.Context, siteID string) (Policy, error) {
	if siteID == "" {
		return Policy{}, ErrInvalidInput
	}
	return s.policyFor(ctx, siteID)
}

// CheckText applies the word list to one piece of text.
//
// It returns ErrRejected when the strictest match is reject mode; a review or
// replace match is reported in the verdict so the caller can set the stored state.
func (s *Service) CheckText(ctx context.Context, siteID, text string) (TextVerdict, error) {
	policy, err := s.policyFor(ctx, siteID)
	if err != nil {
		return TextVerdict{}, err
	}
	verdict := policy.Evaluate(text)
	if verdict.Rejects() {
		return verdict, &RejectedError{Matched: verdict.Matched}
	}
	return verdict, nil
}

// CheckComment applies the frequency limits and then the word list to a comment.
//
// The counters are consumed before the word check on purpose: a blocked submission
// still counts as an attempt, so the limiter also blunts a word-list bypass loop.
func (s *Service) CheckComment(ctx context.Context, in CommentSubmission) (CommentVerdict, error) {
	policy, err := s.policyFor(ctx, in.SiteID)
	if err != nil {
		return CommentVerdict{}, err
	}
	rate := policy.Rate.Normalize()

	if in.IP != "" && rate.IPLimit > 0 {
		allowed, retryAfter := s.limiter.Allow(
			"comment:ip:"+in.SiteID+":"+in.IP, rate.IPLimit, rate.Window,
		)
		if !allowed {
			return CommentVerdict{}, &RateLimitError{RetryAfter: retryAfter, Scope: "ip"}
		}
	}
	if in.UserID != "" && rate.UserLimit > 0 {
		allowed, retryAfter := s.limiter.Allow(
			"comment:user:"+in.SiteID+":"+in.UserID, rate.UserLimit, rate.Window,
		)
		if !allowed {
			return CommentVerdict{}, &RateLimitError{RetryAfter: retryAfter, Scope: "user"}
		}
	}

	verdict := policy.Evaluate(in.Body)
	if verdict.Rejects() {
		return CommentVerdict{}, &RejectedError{Matched: verdict.Matched}
	}
	return CommentVerdict{
		Body:          verdict.Text,
		RequireReview: verdict.RequiresReview(),
		Matched:       verdict.Matched,
		Mode:          verdict.Mode,
	}, nil
}

// AllowsIP reports whether a client address may reach the site.
//
// A deny entry always wins. When at least one allow entry exists, the site only
// accepts listed addresses. Loopback is always allowed so an operator cannot lock
// themselves out of the screen that would remove the rule.
func (s *Service) AllowsIP(ctx context.Context, siteID, address string) (bool, error) {
	if Loopback(address) {
		return true, nil
	}
	policy, err := s.policyFor(ctx, siteID)
	if err != nil {
		return true, err
	}

	allowed := len(policy.IPRules) == 0
	hasAllow := false
	for _, rule := range policy.IPRules {
		if rule.Kind == IPRuleAllow {
			hasAllow = true
		}
		if !IPMatches(address, rule.Value) {
			continue
		}
		if rule.Kind == IPRuleDeny {
			return false, nil
		}
		allowed = true
	}
	if hasAllow {
		return allowed, nil
	}
	return true, nil
}

// ListWords returns the words of a site for management.
func (s *Service) ListWords(ctx context.Context, actor Actor, siteID string) ([]SensitiveWord, error) {
	if err := authorize(actor, siteID); err != nil {
		return nil, err
	}
	words, err := s.repo.ListWords(ctx, siteID)
	if err != nil {
		return nil, err
	}
	return sortedWords(words), nil
}

// CreateWord adds a sensitive word.
func (s *Service) CreateWord(ctx context.Context, actor Actor, siteID string, in WordInput) (SensitiveWord, error) {
	if err := authorize(actor, siteID); err != nil {
		return SensitiveWord{}, err
	}
	word, err := buildWord(siteID, in, s.now())
	if err != nil {
		return SensitiveWord{}, err
	}
	if existing, listErr := s.repo.ListWords(ctx, siteID); listErr == nil {
		for _, candidate := range existing {
			if candidate.Word == word.Word {
				return SensitiveWord{}, ErrConflict
			}
		}
	}
	created, err := s.repo.InsertWord(ctx, word)
	if err != nil {
		return SensitiveWord{}, err
	}
	s.invalidate(siteID)
	s.record(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    actor.UserID,
		Action:     "safety.word.created",
		TargetType: "sensitive_word",
		TargetID:   created.ID,
		Detail:     map[string]any{"word": created.Word, "mode": string(created.Mode)},
		At:         s.now(),
	})
	return created, nil
}

// UpdateWord changes the action of an existing word.
func (s *Service) UpdateWord(ctx context.Context, actor Actor, siteID, wordID string, in WordUpdate) (SensitiveWord, error) {
	if err := authorize(actor, siteID); err != nil {
		return SensitiveWord{}, err
	}
	word, err := s.repo.FindWord(ctx, siteID, wordID)
	if err != nil {
		return SensitiveWord{}, err
	}
	if in.Mode != nil {
		if !in.Mode.Valid() {
			return SensitiveWord{}, ErrInvalidInput
		}
		word.Mode = *in.Mode
	}
	if in.Replacement != nil {
		replacement, replacementErr := normalizeReplacement(*in.Replacement)
		if replacementErr != nil {
			return SensitiveWord{}, replacementErr
		}
		word.Replacement = replacement
	}
	if in.Enabled != nil {
		word.Enabled = *in.Enabled
	}
	word.UpdatedAt = s.now()

	updated, err := s.repo.UpdateWord(ctx, word)
	if err != nil {
		return SensitiveWord{}, err
	}
	s.invalidate(siteID)
	s.record(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    actor.UserID,
		Action:     "safety.word.updated",
		TargetType: "sensitive_word",
		TargetID:   updated.ID,
		Detail: map[string]any{
			"word":    updated.Word,
			"mode":    string(updated.Mode),
			"enabled": updated.Enabled,
		},
		At: s.now(),
	})
	return updated, nil
}

// DeleteWord removes a sensitive word.
func (s *Service) DeleteWord(ctx context.Context, actor Actor, siteID, wordID string) error {
	if err := authorize(actor, siteID); err != nil {
		return err
	}
	word, err := s.repo.FindWord(ctx, siteID, wordID)
	if err != nil {
		return err
	}
	if err := s.repo.DeleteWord(ctx, siteID, wordID); err != nil {
		return err
	}
	s.invalidate(siteID)
	s.record(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    actor.UserID,
		Action:     "safety.word.deleted",
		TargetType: "sensitive_word",
		TargetID:   wordID,
		Detail:     map[string]any{"word": word.Word},
		At:         s.now(),
	})
	return nil
}

// ListIPRules returns the allow and deny entries of a site.
func (s *Service) ListIPRules(ctx context.Context, actor Actor, siteID string) ([]IPRule, error) {
	if err := authorize(actor, siteID); err != nil {
		return nil, err
	}
	rules, err := s.repo.ListIPRules(ctx, siteID)
	if err != nil {
		return nil, err
	}
	return rules, nil
}

// CreateIPRule adds an allow or deny entry.
func (s *Service) CreateIPRule(ctx context.Context, actor Actor, siteID string, in IPRuleInput) (IPRule, error) {
	if err := authorize(actor, siteID); err != nil {
		return IPRule{}, err
	}
	if !in.Kind.Valid() {
		return IPRule{}, ErrInvalidInput
	}
	value, err := ParseIPRuleValue(in.Value)
	if err != nil {
		return IPRule{}, err
	}
	note := strings.TrimSpace(in.Note)
	if utf8.RuneCountInString(note) > MaxNoteRunes {
		return IPRule{}, ErrInvalidInput
	}
	rule := IPRule{
		ID:        uuid.Must(uuid.NewV7()).String(),
		SiteID:    siteID,
		Kind:      in.Kind,
		Value:     value,
		Note:      note,
		CreatedAt: s.now(),
	}
	created, err := s.repo.InsertIPRule(ctx, rule)
	if err != nil {
		return IPRule{}, err
	}
	s.invalidate(siteID)
	s.record(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    actor.UserID,
		Action:     "safety.ip_rule.created",
		TargetType: "site_ip_rule",
		TargetID:   created.ID,
		Detail:     map[string]any{"kind": string(created.Kind), "value": created.Value},
		At:         s.now(),
	})
	return created, nil
}

// DeleteIPRule removes an allow or deny entry.
func (s *Service) DeleteIPRule(ctx context.Context, actor Actor, siteID, ruleID string) error {
	if err := authorize(actor, siteID); err != nil {
		return err
	}
	rule, err := s.repo.FindIPRule(ctx, siteID, ruleID)
	if err != nil {
		return err
	}
	if err := s.repo.DeleteIPRule(ctx, siteID, ruleID); err != nil {
		return err
	}
	s.invalidate(siteID)
	s.record(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    actor.UserID,
		Action:     "safety.ip_rule.deleted",
		TargetType: "site_ip_rule",
		TargetID:   ruleID,
		Detail:     map[string]any{"kind": string(rule.Kind), "value": rule.Value},
		At:         s.now(),
	})
	return nil
}

// RateLimit returns the configured comment frequency limits of a site.
//
// A site that never opened the safety screen answers the documented defaults rather
// than a not-found error, so the admin UI always has concrete numbers to show.
func (s *Service) RateLimit(ctx context.Context, actor Actor, siteID string) (RateConfig, error) {
	if err := authorize(actor, siteID); err != nil {
		return RateConfig{}, err
	}
	config, err := s.repo.RateConfig(ctx, siteID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return DefaultRateConfig(), nil
		}
		return RateConfig{}, err
	}
	return config.Normalize(), nil
}

// UpdateRateLimit changes the comment frequency limits of a site.
func (s *Service) UpdateRateLimit(ctx context.Context, actor Actor, siteID string, in RateLimitInput) (RateConfig, error) {
	if err := authorize(actor, siteID); err != nil {
		return RateConfig{}, err
	}
	current, err := s.repo.RateConfig(ctx, siteID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return RateConfig{}, err
	}
	config := current.Normalize()
	if in.UserLimit != nil {
		config.UserLimit = *in.UserLimit
	}
	if in.IPLimit != nil {
		config.IPLimit = *in.IPLimit
	}
	if in.WindowSeconds != nil {
		config.Window = time.Duration(*in.WindowSeconds) * time.Second
	}
	if err := validateRateConfig(config); err != nil {
		return RateConfig{}, err
	}
	if err := s.repo.SaveRateConfig(ctx, siteID, config, s.now()); err != nil {
		return RateConfig{}, err
	}
	s.invalidate(siteID)
	s.record(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    actor.UserID,
		Action:     "safety.rate_limit.updated",
		TargetType: "site",
		TargetID:   siteID,
		Detail: map[string]any{
			"user_per_window": config.UserLimit,
			"ip_per_window":   config.IPLimit,
			"window_seconds":  int(config.Window / time.Second),
		},
		At: s.now(),
	})
	return config, nil
}

// policyFor resolves and caches the policy of one site.
func (s *Service) policyFor(ctx context.Context, siteID string) (Policy, error) {
	if siteID == "" {
		// No site means no configured policy: an empty policy allows normal traffic
		// rather than failing requests that no site resolver governs.
		return Policy{Rate: DefaultRateConfig()}, nil
	}
	if s.cacheTTL > 0 {
		s.mu.RLock()
		entry, ok := s.cache[siteID]
		s.mu.RUnlock()
		if ok && s.now().Before(entry.expires) {
			return entry.policy, nil
		}
	}

	words, err := s.repo.ListWords(ctx, siteID)
	if err != nil {
		return Policy{}, err
	}
	rules, err := s.repo.ListIPRules(ctx, siteID)
	if err != nil {
		return Policy{}, err
	}
	rate, err := s.repo.RateConfig(ctx, siteID)
	if err != nil {
		if !errors.Is(err, ErrNotFound) {
			return Policy{}, err
		}
		rate = DefaultRateConfig()
	}

	policy := Policy{Words: words, IPRules: rules, Rate: rate.Normalize()}
	if s.cacheTTL > 0 {
		s.mu.Lock()
		s.cache[siteID] = policyCacheEntry{policy: policy, expires: s.now().Add(s.cacheTTL)}
		s.mu.Unlock()
	}
	return policy, nil
}

// invalidate drops the cached policy of one site.
func (s *Service) invalidate(siteID string) {
	s.mu.Lock()
	delete(s.cache, siteID)
	s.mu.Unlock()
}

// record appends an audit entry, ignoring a recorder failure by design.
func (s *Service) record(ctx context.Context, entry audit.Entry) {
	if s.audit == nil {
		return
	}
	entry.Outcome = "success"
	_ = s.audit.Record(ctx, entry)
}

// buildWord validates and normalises a new word.
func buildWord(siteID string, in WordInput, now time.Time) (SensitiveWord, error) {
	normalized := NormalizeWord(in.Word)
	count := utf8.RuneCountInString(normalized)
	if normalized == "" || count < MinWordRunes || count > MaxWordRunes {
		return SensitiveWord{}, ErrInvalidInput
	}
	mode := in.Mode
	if mode == "" {
		mode = ModeReject
	}
	if !mode.Valid() {
		return SensitiveWord{}, ErrInvalidInput
	}
	replacement, err := normalizeReplacement(in.Replacement)
	if err != nil {
		return SensitiveWord{}, err
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	return SensitiveWord{
		ID:          uuid.Must(uuid.NewV7()).String(),
		SiteID:      siteID,
		Word:        normalized,
		Mode:        mode,
		Replacement: replacement,
		Enabled:     enabled,
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}

// normalizeReplacement validates the placeholder of replace mode.
func normalizeReplacement(raw string) (string, error) {
	replacement := strings.TrimSpace(raw)
	if replacement == "" {
		return DefaultReplacement, nil
	}
	if utf8.RuneCountInString(replacement) > MaxReplacementRunes {
		return "", ErrInvalidInput
	}
	return replacement, nil
}

// validateRateConfig enforces the documented bounds.
func validateRateConfig(config RateConfig) error {
	if config.UserLimit < 0 || config.UserLimit > MaxCommentUserLimit {
		return ErrInvalidInput
	}
	if config.IPLimit < 0 || config.IPLimit > MaxCommentIPLimit {
		return ErrInvalidInput
	}
	seconds := int(config.Window / time.Second)
	if seconds < MinCommentWindowSeconds || seconds > MaxCommentWindowSeconds {
		return ErrInvalidInput
	}
	return nil
}

// authorize rejects a caller who may not manage this site's safety policy.
//
// Managing content safety is site administration, exactly like changing the comment
// switches, and the site in the path must be the site the session was issued for.
func authorize(actor Actor, siteID string) error {
	if actor.UserID == "" || siteID == "" {
		return ErrPermissionDenied
	}
	if actor.SiteID != siteID {
		return ErrPermissionDenied
	}
	if !actor.Role.AtLeast(site.RoleSiteAdmin) {
		return ErrPermissionDenied
	}
	return nil
}
