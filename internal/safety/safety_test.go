package safety

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/site"
)

// memoryRepo is an in-memory Repository for policy tests.
type memoryRepo struct {
	words []SensitiveWord
	rules []IPRule
	rate  *RateConfig
}

func (r *memoryRepo) ListWords(context.Context, string) ([]SensitiveWord, error) {
	return append([]SensitiveWord(nil), r.words...), nil
}

func (r *memoryRepo) InsertWord(_ context.Context, word SensitiveWord) (SensitiveWord, error) {
	for _, existing := range r.words {
		if existing.SiteID == word.SiteID && existing.Word == word.Word {
			return SensitiveWord{}, ErrConflict
		}
	}
	r.words = append(r.words, word)
	return word, nil
}

func (r *memoryRepo) FindWord(_ context.Context, siteID, wordID string) (SensitiveWord, error) {
	for _, word := range r.words {
		if word.SiteID == siteID && word.ID == wordID {
			return word, nil
		}
	}
	return SensitiveWord{}, ErrNotFound
}

func (r *memoryRepo) UpdateWord(_ context.Context, word SensitiveWord) (SensitiveWord, error) {
	for index, existing := range r.words {
		if existing.ID == word.ID {
			r.words[index] = word
			return word, nil
		}
	}
	return SensitiveWord{}, ErrNotFound
}

func (r *memoryRepo) DeleteWord(_ context.Context, siteID, wordID string) error {
	for index, word := range r.words {
		if word.SiteID == siteID && word.ID == wordID {
			r.words = append(r.words[:index], r.words[index+1:]...)
			return nil
		}
	}
	return ErrNotFound
}

func (r *memoryRepo) ListIPRules(context.Context, string) ([]IPRule, error) {
	return append([]IPRule(nil), r.rules...), nil
}

func (r *memoryRepo) InsertIPRule(_ context.Context, rule IPRule) (IPRule, error) {
	for _, existing := range r.rules {
		if existing.SiteID == rule.SiteID && existing.Kind == rule.Kind && existing.Value == rule.Value {
			return IPRule{}, ErrConflict
		}
	}
	r.rules = append(r.rules, rule)
	return rule, nil
}

func (r *memoryRepo) FindIPRule(_ context.Context, siteID, ruleID string) (IPRule, error) {
	for _, rule := range r.rules {
		if rule.SiteID == siteID && rule.ID == ruleID {
			return rule, nil
		}
	}
	return IPRule{}, ErrNotFound
}

func (r *memoryRepo) DeleteIPRule(_ context.Context, siteID, ruleID string) error {
	for index, rule := range r.rules {
		if rule.SiteID == siteID && rule.ID == ruleID {
			r.rules = append(r.rules[:index], r.rules[index+1:]...)
			return nil
		}
	}
	return ErrNotFound
}

func (r *memoryRepo) RateConfig(context.Context, string) (RateConfig, error) {
	if r.rate == nil {
		return RateConfig{}, ErrNotFound
	}
	return *r.rate, nil
}

func (r *memoryRepo) SaveRateConfig(_ context.Context, _ string, cfg RateConfig, _ time.Time) error {
	r.rate = &cfg
	return nil
}

// memoryAudit records the entries written by privileged changes.
type memoryAudit struct {
	mu      sync.Mutex
	entries []audit.Entry
}

func (a *memoryAudit) Record(_ context.Context, entry audit.Entry) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.entries = append(a.entries, entry)
	return nil
}

func (a *memoryAudit) actions() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, 0, len(a.entries))
	for _, entry := range a.entries {
		out = append(out, entry.Action)
	}
	return out
}

func testService(t *testing.T) (*Service, *memoryRepo, *memoryAudit, *time.Time) {
	t.Helper()
	repo := &memoryRepo{}
	recorder := &memoryAudit{}
	clock := time.Date(2026, 11, 7, 4, 0, 0, 0, time.UTC)
	service, err := NewService(
		repo,
		WithAudit(recorder),
		WithClock(func() time.Time { return clock }),
		// Unit tests mutate the fake store directly, so each call must see the current
		// fixture; the caching behaviour has its own test.
		WithCacheTTL(0),
	)
	require.NoError(t, err)
	return service, repo, recorder, &clock
}

func adminActor() Actor {
	return Actor{UserID: "user_admin", SiteID: "site_1", Role: site.RoleSiteAdmin}
}

func TestEvaluatePicksStrictestModeAndReplaces(t *testing.T) {
	policy := Policy{Words: []SensitiveWord{
		{Word: "badword", Mode: ModeReplace, Replacement: "***", Enabled: true},
		{Word: "evil", Mode: ModeReview, Replacement: "***", Enabled: true},
		{Word: "forbid", Mode: ModeReject, Replacement: "***", Enabled: true},
	}}

	verdict := policy.Evaluate("A BadWord and EVIL showed up")
	require.True(t, verdict.Hit())
	require.Equal(t, ModeReview, verdict.Mode)
	require.ElementsMatch(t, []string{"badword", "evil"}, verdict.Matched)
	require.Equal(t, "A *** and EVIL showed up", verdict.Text)

	rejected := policy.Evaluate("this is FORBID")
	require.True(t, rejected.Rejects())
	require.Equal(t, ModeReject, rejected.Mode)
}

func TestEvaluateUsesWordBoundariesForASCII(t *testing.T) {
	policy := Policy{Words: []SensitiveWord{
		{Word: "ass", Mode: ModeReject, Enabled: true},
	}}
	require.False(t, policy.Evaluate("a classic passage").Hit())
	require.True(t, policy.Evaluate("what an ass").Hit())
}

func TestEvaluateIgnoresDisabledWords(t *testing.T) {
	policy := Policy{Words: []SensitiveWord{
		{Word: "hidden", Mode: ModeReject, Enabled: false},
	}}
	require.False(t, policy.Evaluate("hidden").Hit())
}

func TestCheckCommentLimitsAnonymousByIP(t *testing.T) {
	service, repo, _, clock := testService(t)
	repo.rate = &RateConfig{UserLimit: 5, IPLimit: 2, Window: time.Minute}

	in := CommentSubmission{SiteID: "site_1", IP: "203.0.113.9", Body: "hello"}
	for index := 0; index < 2; index++ {
		verdict, err := service.CheckComment(context.Background(), in)
		require.NoError(t, err)
		require.Equal(t, "hello", verdict.Body)
	}

	_, err := service.CheckComment(context.Background(), in)
	require.ErrorIs(t, err, ErrRateLimited)
	var rateErr *RateLimitError
	require.ErrorAs(t, err, &rateErr)
	require.Equal(t, "ip", rateErr.Scope)
	require.Greater(t, rateErr.RetryAfter, time.Duration(0))
	require.LessOrEqual(t, rateErr.RetryAfter, time.Minute)

	// The next window admits the address again.
	*clock = clock.Add(time.Minute)
	_, err = service.CheckComment(context.Background(), in)
	require.NoError(t, err)
}

func TestCheckCommentLimitsSignedInByUser(t *testing.T) {
	service, repo, _, _ := testService(t)
	repo.rate = &RateConfig{UserLimit: 1, IPLimit: 0, Window: time.Minute}

	in := CommentSubmission{SiteID: "site_1", UserID: "user_1", IP: "203.0.113.9", Body: "hi"}
	_, err := service.CheckComment(context.Background(), in)
	require.NoError(t, err)

	_, err = service.CheckComment(context.Background(), in)
	require.ErrorIs(t, err, ErrRateLimited)
	var rateErr *RateLimitError
	require.ErrorAs(t, err, &rateErr)
	require.Equal(t, "user", rateErr.Scope)
}

func TestCheckCommentRejectsSensitiveWord(t *testing.T) {
	service, repo, _, _ := testService(t)
	repo.words = []SensitiveWord{
		{Word: "forbid", Mode: ModeReject, Enabled: true},
	}
	_, err := service.CheckComment(context.Background(), CommentSubmission{
		SiteID: "site_1", UserID: "user_1", Body: "please FORBID this",
	})
	require.ErrorIs(t, err, ErrRejected)

	var rejected *RejectedError
	require.ErrorAs(t, err, &rejected)
	require.Equal(t, []string{"forbid"}, rejected.Matched)
}

func TestAllowsIPHonoursDenyAllowAndLoopback(t *testing.T) {
	service, repo, _, _ := testService(t)
	repo.rules = []IPRule{
		{ID: "r1", SiteID: "site_1", Kind: IPRuleDeny, Value: "198.51.100.7"},
	}
	allowed, err := service.AllowsIP(context.Background(), "site_1", "198.51.100.7")
	require.NoError(t, err)
	require.False(t, allowed)

	allowed, err = service.AllowsIP(context.Background(), "site_1", "203.0.113.9")
	require.NoError(t, err)
	require.True(t, allowed)

	// Adding an allow rule restricts the site to the listed entries, but loopback
	// stays reachable so the operator can fix it.
	repo.rules = append(repo.rules, IPRule{
		ID: "r2", SiteID: "site_1", Kind: IPRuleAllow, Value: "203.0.113.0/24",
	})
	allowed, err = service.AllowsIP(context.Background(), "site_1", "203.0.113.9")
	require.NoError(t, err)
	require.True(t, allowed)

	allowed, err = service.AllowsIP(context.Background(), "site_1", "192.0.2.5")
	require.NoError(t, err)
	require.False(t, allowed)

	allowed, err = service.AllowsIP(context.Background(), "site_1", "127.0.0.1")
	require.NoError(t, err)
	require.True(t, allowed)

	allowed, err = service.AllowsIP(context.Background(), "site_1", "::1")
	require.NoError(t, err)
	require.True(t, allowed)
}

func TestWordLifecycleIsAuthorizedAndAudited(t *testing.T) {
	service, _, recorder, _ := testService(t)
	ctx := context.Background()

	created, err := service.CreateWord(ctx, adminActor(), "site_1", WordInput{Word: "  BadWord ", Mode: ModeReplace})
	require.NoError(t, err)
	require.Equal(t, "badword", created.Word)
	require.Equal(t, "***", created.Replacement)

	_, err = service.CreateWord(ctx, adminActor(), "site_1", WordInput{Word: "badword"})
	require.ErrorIs(t, err, ErrConflict)

	_, err = service.CreateWord(ctx, Actor{UserID: "user", SiteID: "site_1", Role: site.RoleMember}, "site_1", WordInput{Word: "other"})
	require.ErrorIs(t, err, ErrPermissionDenied)

	mode := ModeReview
	updated, err := service.UpdateWord(ctx, adminActor(), "site_1", created.ID, WordUpdate{Mode: &mode})
	require.NoError(t, err)
	require.Equal(t, ModeReview, updated.Mode)

	require.NoError(t, service.DeleteWord(ctx, adminActor(), "site_1", created.ID))
	require.ErrorIs(t, service.DeleteWord(ctx, adminActor(), "site_1", created.ID), ErrNotFound)

	require.Equal(t, []string{
		"safety.word.created",
		"safety.word.updated",
		"safety.word.deleted",
	}, recorder.actions())
}

func TestIPRuleAndRateLimitLifecycle(t *testing.T) {
	service, repo, recorder, _ := testService(t)
	ctx := context.Background()

	rule, err := service.CreateIPRule(ctx, adminActor(), "site_1", IPRuleInput{
		Kind: IPRuleDeny, Value: "2001:db8::1", Note: "scanner",
	})
	require.NoError(t, err)
	require.Equal(t, "2001:db8::1", rule.Value)

	_, err = service.CreateIPRule(ctx, adminActor(), "site_1", IPRuleInput{Kind: IPRuleDeny, Value: "not-an-ip"})
	require.ErrorIs(t, err, ErrInvalidInput)

	require.NoError(t, service.DeleteIPRule(ctx, adminActor(), "site_1", rule.ID))

	userLimit, ipLimit, window := 3, 8, 30
	config, err := service.UpdateRateLimit(ctx, adminActor(), "site_1", RateLimitInput{
		UserLimit: &userLimit, IPLimit: &ipLimit, WindowSeconds: &window,
	})
	require.NoError(t, err)
	require.Equal(t, 3, config.UserLimit)
	require.Equal(t, 8, config.IPLimit)
	require.Equal(t, 30*time.Second, config.Window)
	require.NotNil(t, repo.rate)

	require.Equal(t, []string{
		"safety.ip_rule.created",
		"safety.ip_rule.deleted",
		"safety.rate_limit.updated",
	}, recorder.actions())
}

func TestPolicyCacheInvalidatedOnWrite(t *testing.T) {
	repo := &memoryRepo{}
	recorder := &memoryAudit{}
	service, err := NewService(repo, WithAudit(recorder), WithCacheTTL(time.Minute))
	require.NoError(t, err)
	ctx := context.Background()

	verdict, err := service.CheckText(ctx, "site_1", "forbid")
	require.NoError(t, err)
	require.False(t, verdict.Hit())

	_, err = service.CreateWord(ctx, adminActor(), "site_1", WordInput{Word: "forbid", Mode: ModeReject})
	require.NoError(t, err)

	_, err = service.CheckText(ctx, "site_1", "forbid")
	require.ErrorIs(t, err, ErrRejected)
}

func TestParseIPRuleValueCanonicalises(t *testing.T) {
	value, err := ParseIPRuleValue("203.0.113.10/24")
	require.NoError(t, err)
	require.Equal(t, "203.0.113.0/24", value)

	value, err = ParseIPRuleValue("2001:0db8::1")
	require.NoError(t, err)
	require.Equal(t, "2001:db8::1", value)

	_, err = ParseIPRuleValue("localhost")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestNormalizeWordStripsZeroWidth(t *testing.T) {
	require.Equal(t, "bad", NormalizeWord("  B\u200bad  "))
	require.True(t, Policy{Words: []SensitiveWord{
		{Word: "bad", Mode: ModeReject, Enabled: true},
	}}.Evaluate("b\u200ba\u200bd").Hit())
}

func TestBuildWordRejectsTooShort(t *testing.T) {
	_, err := buildWord("site_1", WordInput{Word: "a"}, time.Now())
	require.ErrorIs(t, err, ErrInvalidInput)

	_, err = buildWord("site_1", WordInput{Word: "ab", Mode: WordMode("nonsense")}, time.Now())
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestRateLimitStoreFixedWindow(t *testing.T) {
	clock := time.Date(2026, 11, 7, 4, 0, 0, 0, time.UTC)
	store := NewMemoryRateLimitStore(func() time.Time { return clock })

	allowed, _ := store.Allow("key", 1, time.Minute)
	require.True(t, allowed)
	allowed, retry := store.Allow("key", 1, time.Minute)
	require.False(t, allowed)
	require.Equal(t, time.Minute, retry)

	clock = clock.Add(time.Minute)
	allowed, _ = store.Allow("key", 1, time.Minute)
	require.True(t, allowed)
}

func TestZeroLimitDisablesCounter(t *testing.T) {
	service, repo, _, _ := testService(t)
	repo.rate = &RateConfig{UserLimit: 0, IPLimit: 0, Window: time.Minute}
	for index := 0; index < 10; index++ {
		_, err := service.CheckComment(context.Background(), CommentSubmission{
			SiteID: "site_1", UserID: "user_1", IP: "203.0.113.9", Body: "hi",
		})
		require.NoError(t, err)
	}
}

func TestAllowsIPReportsRepositoryFailure(t *testing.T) {
	failing := &failingRepo{memoryRepo: &memoryRepo{}}
	service, err := NewService(failing, WithCacheTTL(0))
	require.NoError(t, err)

	allowed, err := service.AllowsIP(context.Background(), "site_1", "203.0.113.9")
	require.Error(t, err)
	// The guard fails open; the middleware treats the error as "do not block".
	require.True(t, allowed)
}

type failingRepo struct{ *memoryRepo }

func (r *failingRepo) ListWords(context.Context, string) ([]SensitiveWord, error) {
	return nil, errors.New("db down")
}
