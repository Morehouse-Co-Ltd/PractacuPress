package captcha

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
)

// CustomizationSource reads a site's stored design document.
//
// The captcha intent lives in that document (the settings page saves it with the
// rest of the site design), so the guard asks the site module for the bytes
// instead of owning a second copy that could drift. A nil document with a nil
// error means "the site never saved one", which reads as "not enabled".
type CustomizationSource func(ctx context.Context, siteID string) ([]byte, error)

// GuardConfig configures a Guard.
type GuardConfig struct {
	// Verifier redeems tokens. Nil makes the guard inert, which is what tests
	// that do not model captcha get.
	Verifier *Verifier
	// Customization reads the site intent. Nil makes every scene unenforced.
	Customization CustomizationSource
	// Audit records rejected attempts. Nil skips the trail.
	Audit audit.Recorder
	// Logger records operator mistakes (a site enabled a provider without a
	// secret) and provider failures. Nil discards them.
	Logger *slog.Logger
	// Now is the clock, for tests.
	Now func() time.Time
}

// Guard enforces the site's captcha policy on the protected endpoints.
type Guard struct {
	verifier      *Verifier
	customization CustomizationSource
	audit         audit.Recorder
	logger        *slog.Logger
	now           func() time.Time

	// warned throttles the "enabled but not configured" log. The condition is an
	// operator mistake that persists across every request until the secret is
	// deployed; logging it once per request would bury the rest of the log.
	mu       sync.Mutex
	warnedAt map[string]time.Time
}

// warnInterval is how often the same unenforced site may warn.
const warnInterval = 5 * time.Minute

// NewGuard builds a Guard.
func NewGuard(cfg GuardConfig) *Guard {
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Guard{
		verifier:      cfg.Verifier,
		customization: cfg.Customization,
		audit:         cfg.Audit,
		logger:        logger,
		now:           now,
		warnedAt:      make(map[string]time.Time),
	}
}

// Policy returns the effective rule for a site.
//
// A site that never saved a design document is reported as "off"; a storage
// failure is reported as an error so the caller can answer 503 instead of
// pretending the form is protected.
func (g *Guard) Policy(ctx context.Context, siteID string) (Policy, error) {
	if g == nil || g.verifier == nil || g.customization == nil || siteID == "" {
		return Policy{Settings: DefaultSettings()}, nil
	}
	document, err := g.customization(ctx, siteID)
	if err != nil {
		return Policy{}, err
	}
	settings := ParseSettings(document)
	policy := Policy{
		Settings:         settings,
		SecretConfigured: g.verifier.Configured(settings.Provider),
	}
	policy.Effective = settings.Enabled && policy.SecretConfigured && settings.SiteKey != ""
	return policy, nil
}

// RequireInput is one protected request.
type RequireInput struct {
	SiteID    string
	Scene     Scene
	Token     string
	RemoteIP  string
	ActorID   string
	RequestID string
}

// Require enforces the policy for one request.
//
// The outcomes are deliberately narrow:
//
//   - nil when the scene is not protected, including the "enabled but the server
//     has no secret" case, which is logged loudly instead of being enforced by a
//     check that cannot succeed;
//   - a sentinel error when a required token is missing, replayed or refused.
//
// Callers must treat any error as "do not perform the action".
func (g *Guard) Require(ctx context.Context, in RequireInput) error {
	if g == nil || g.verifier == nil {
		return nil
	}
	if !in.Scene.Valid() {
		// A developer error, not a visitor one: refuse rather than silently
		// skipping a check the caller believed it configured.
		return ErrSceneUnknown
	}
	policy, err := g.Policy(ctx, in.SiteID)
	if err != nil {
		g.logger.Warn("captcha policy unavailable",
			"site_id", in.SiteID, "scene", in.Scene, "error", err)
		return errors.Join(ErrPolicyUnavailable, err)
	}
	if !policy.Settings.Enabled || !policy.Settings.SceneEnabled(in.Scene) {
		return nil
	}
	if !policy.Effective {
		g.warnUnenforced(in.SiteID, policy)
		return nil
	}

	_, err = g.verifier.Verify(ctx, Request{
		Provider: policy.Settings.Provider,
		Token:    in.Token,
		RemoteIP: in.RemoteIP,
		SiteKey:  policy.Settings.SiteKey,
		Scene:    in.Scene,
	})
	if err != nil {
		g.recordFailure(ctx, in, policy.Settings.Provider, err)
		return err
	}
	return nil
}

// warnUnenforced logs the operator mistake behind an unenforced scene.
func (g *Guard) warnUnenforced(siteID string, policy Policy) {
	reason := "no secret is configured for this provider"
	if policy.Settings.SiteKey == "" {
		reason = "no site key is saved for this provider"
	}

	key := siteID + "\x00" + string(policy.Settings.Provider) + "\x00" + reason
	now := g.now()
	g.mu.Lock()
	last, seen := g.warnedAt[key]
	if seen && now.Sub(last) < warnInterval {
		g.mu.Unlock()
		return
	}
	if len(g.warnedAt) > 256 {
		for existing, at := range g.warnedAt {
			if now.Sub(at) >= warnInterval {
				delete(g.warnedAt, existing)
			}
		}
	}
	g.warnedAt[key] = now
	g.mu.Unlock()

	g.logger.Warn("captcha is enabled for this site but cannot be enforced: "+reason,
		"site_id", siteID,
		"provider", policy.Settings.Provider,
		"set_env", secretEnvName(policy.Settings.Provider),
	)
}

// secretEnvName names the variable an operator has to set.
func secretEnvName(provider Provider) string {
	switch provider {
	case ProviderTurnstile:
		return "CAPTCHA_TURNSTILE_SECRET"
	case ProviderHCaptcha:
		return "CAPTCHA_HCAPTCHA_SECRET"
	case ProviderRecaptcha:
		return "CAPTCHA_RECAPTCHA_SECRET"
	default:
		return "CAPTCHA_<PROVIDER>_SECRET"
	}
}

// recordFailure appends the audit row for a refused attempt.
//
// The row never contains the token itself: a redeemed token is a credential for
// the provider's stats, and an audit table is copied into backups. The reason,
// provider and scene are enough to investigate, and the request id ties the row
// to the HTTP log.
func (g *Guard) recordFailure(ctx context.Context, in RequireInput, provider Provider, cause error) {
	reason := Reason(cause)
	g.logger.Warn("captcha verification failed",
		"site_id", in.SiteID,
		"scene", in.Scene,
		"provider", provider,
		"reason", reason,
		"error", cause,
	)
	if g.audit == nil {
		return
	}
	detail := map[string]any{
		"scene":    string(in.Scene),
		"provider": string(provider),
		"reason":   reason,
	}
	if in.RemoteIP != "" {
		detail["remote_ip"] = strings.TrimSpace(in.RemoteIP)
	}
	if err := g.audit.Record(ctx, audit.Entry{
		SiteID:    in.SiteID,
		ActorID:   in.ActorID,
		Action:    "auth.captcha.failed",
		RequestID: in.RequestID,
		Outcome:   "failure",
		Detail:    detail,
		At:        g.now(),
	}); err != nil {
		// The visitor is already being refused; losing the audit row is worth a
		// log line but must not change the response.
		g.logger.Error("record captcha audit entry failed", "error", err, "site_id", in.SiteID)
	}
}
