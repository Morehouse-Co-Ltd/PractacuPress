package captcha

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Provider siteverify endpoints. They are constants rather than configuration so a
// typo cannot send a secret to an arbitrary host; Config.Endpoints exists only so
// tests and a self-hosted gateway can point at a fake.
const (
	endpointTurnstile = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	endpointHCaptcha  = "https://api.hcaptcha.com/siteverify"
	endpointRecaptcha = "https://www.google.com/recaptcha/api/siteverify"
)

// Defaults for the verifier. The timeout is deliberately short: a login should not
// hang for the provider's full patience, and a slow siteverify is a failed check.
const (
	DefaultTimeout    = 5 * time.Second
	DefaultMinScore   = 0.5
	DefaultReplayTTL  = 10 * time.Minute
	DefaultReplaySize = 4096
	// maxResponseBytes bounds the siteverify body. Every provider answers with a
	// small JSON object; anything larger is a broken endpoint or a hostile proxy.
	maxResponseBytes = 64 << 10
)

// Config configures a Verifier.
type Config struct {
	// Secrets maps each provider to the server secret. An empty or missing entry
	// means that provider is not configured, and the guard treats a site that
	// selected it as unenforced rather than silently passing.
	Secrets map[Provider]string
	// Endpoints overrides the provider siteverify URL per provider. Tests point
	// this at an httptest server; production leaves it empty.
	Endpoints map[Provider]string
	// HTTPClient performs the siteverify call. Nil uses an http.Client with
	// Timeout.
	HTTPClient *http.Client
	// Timeout bounds one verification. Zero uses DefaultTimeout.
	Timeout time.Duration
	// MinScore is the reCAPTCHA v3 threshold. Zero uses DefaultMinScore; a
	// negative value disables the score check.
	MinScore float64
	// ReplayTTL is how long a redeemed token is remembered. Zero uses
	// DefaultReplayTTL.
	ReplayTTL time.Duration
	// ReplaySize caps the replay table. Zero uses DefaultReplaySize.
	ReplaySize int
	// Now is the clock, for tests.
	Now func() time.Time
	// Logger records provider failures. Nil discards them.
	Logger *slog.Logger
}

// Result is one accepted provider answer.
type Result struct {
	Provider   Provider
	Score      *float64
	Action     string
	Hostname   string
	ErrorCodes []string
	CheckedAt  time.Time
}

// Request is one token to verify.
type Request struct {
	Provider Provider
	Token    string
	// RemoteIP is the visitor address sent to the provider. Providers use it to
	// score the challenge; it is optional and omitted when empty.
	RemoteIP string
	// SiteKey is only needed by hCaptcha, which echoes it in its server side
	// verification.
	SiteKey string
	// Scene is the protected form. It becomes the expected reCAPTCHA v3 action.
	Scene Scene
}

// Verifier redeems challenge tokens against a provider's siteverify endpoint.
type Verifier struct {
	secrets   map[Provider]string
	endpoints map[Provider]string
	client    *http.Client
	timeout   time.Duration
	minScore  float64
	logger    *slog.Logger
	now       func() time.Time

	replayTTL  time.Duration
	replaySize int

	mu     sync.Mutex
	replay map[string]time.Time
}

// NewVerifier builds a Verifier.
//
// It never fails: a process without any secret is a valid configuration (the
// feature is simply off), and the sites that selected a provider are reported as
// unenforced by the guard.
func NewVerifier(cfg Config) *Verifier {
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	minScore := cfg.MinScore
	if minScore == 0 {
		minScore = DefaultMinScore
	}
	replayTTL := cfg.ReplayTTL
	if replayTTL <= 0 {
		replayTTL = DefaultReplayTTL
	}
	replaySize := cfg.ReplaySize
	if replaySize <= 0 {
		replaySize = DefaultReplaySize
	}

	secrets := make(map[Provider]string, len(cfg.Secrets))
	for provider, secret := range cfg.Secrets {
		if trimmed := strings.TrimSpace(secret); trimmed != "" {
			secrets[provider] = trimmed
		}
	}
	endpoints := make(map[Provider]string, len(cfg.Endpoints))
	for provider, endpoint := range cfg.Endpoints {
		if trimmed := strings.TrimSpace(endpoint); trimmed != "" {
			endpoints[provider] = trimmed
		}
	}

	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	return &Verifier{
		secrets:    secrets,
		endpoints:  endpoints,
		client:     client,
		timeout:    timeout,
		minScore:   minScore,
		logger:     logger,
		now:        now,
		replayTTL:  replayTTL,
		replaySize: replaySize,
		replay:     make(map[string]time.Time),
	}
}

// Configured reports whether the process holds a secret for p.
func (v *Verifier) Configured(p Provider) bool {
	_, ok := v.secrets[p]
	return ok
}

// ConfiguredProviders lists the providers this process can verify.
func (v *Verifier) ConfiguredProviders() []Provider {
	out := make([]Provider, 0, len(v.secrets))
	for _, provider := range Providers {
		if v.Configured(provider) {
			out = append(out, provider)
		}
	}
	return out
}

// siteVerifyResponse is the union of the three providers' answers.
//
// Turnstile and hCaptcha reuse Google's field names, so one struct covers all
// three; the pointer on Score keeps "v2 has no score" distinguishable from "v3
// scored 0".
type siteVerifyResponse struct {
	Success     bool     `json:"success"`
	Score       *float64 `json:"score"`
	Action      string   `json:"action"`
	ChallengeTS string   `json:"challenge_ts"`
	Hostname    string   `json:"hostname"`
	ErrorCodes  []string `json:"error-codes"`
	CData       string   `json:"cdata"`
	Credit      *bool    `json:"credit"`
}

// Verify redeems one token.
//
// A token is accepted at most once. The replay table is what turns the provider's
// "this token was already solved" guarantee into a server side one: without it a
// captured token could be submitted to the same endpoint twice before the provider
// noticed, and both requests would look valid.
func (v *Verifier) Verify(ctx context.Context, req Request) (Result, error) {
	if !req.Provider.Valid() {
		return Result{}, fmt.Errorf("%w: %q", ErrProviderUnknown, req.Provider)
	}
	secret, ok := v.secrets[req.Provider]
	if !ok {
		return Result{}, fmt.Errorf("%w: %s", ErrNotConfigured, req.Provider)
	}
	token := strings.TrimSpace(req.Token)
	if token == "" {
		return Result{}, ErrTokenMissing
	}
	if v.seen(req.Provider, token) {
		return Result{}, fmt.Errorf("%w: %s", ErrReplay, req.Provider)
	}

	endpoint := v.endpoints[req.Provider]
	if endpoint == "" {
		endpoint = defaultEndpoint(req.Provider)
	}

	form := url.Values{}
	form.Set("secret", secret)
	form.Set("response", token)
	if req.RemoteIP != "" {
		form.Set("remoteip", req.RemoteIP)
	}
	if req.Provider == ProviderHCaptcha && req.SiteKey != "" {
		form.Set("sitekey", req.SiteKey)
	}

	callCtx, cancel := context.WithTimeout(ctx, v.timeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(
		callCtx,
		http.MethodPost,
		endpoint,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	httpReq.Header.Set("Accept", "application/json")

	resp, err := v.client.Do(httpReq)
	if err != nil {
		return Result{}, classifyTransportError(req.Provider, err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return Result{}, classifyTransportError(req.Provider, err)
	}
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("%w: %s answered %d", ErrUpstream, req.Provider, resp.StatusCode)
	}

	var answer siteVerifyResponse
	if err := json.Unmarshal(body, &answer); err != nil {
		return Result{}, fmt.Errorf("%w: %s answered with malformed json", ErrUpstream, req.Provider)
	}
	result := Result{
		Provider:   req.Provider,
		Score:      answer.Score,
		Action:     strings.TrimSpace(answer.Action),
		Hostname:   answer.Hostname,
		ErrorCodes: answer.ErrorCodes,
		CheckedAt:  v.now(),
	}
	if !answer.Success {
		return result, fmt.Errorf("%w: %s %s", ErrRejected, req.Provider, errorCodeList(answer.ErrorCodes))
	}

	result, err = v.applyThresholds(req, result)
	if err != nil {
		return result, err
	}

	// The token is only burned once it passed every local rule: a score failure
	// must not make the visitor's next attempt look like a replay.
	v.remember(req.Provider, token)
	return result, nil
}

// applyThresholds enforces the reCAPTCHA v3 score and action rules.
//
// They only apply to an answer that carries the v3 fields. reCAPTCHA v2 answers
// with neither, and Turnstile answers with an action only when the widget was
// rendered with one; treating a missing score as "zero" would reject every v2
// deployment, so the fields decide the branch instead of the provider name.
func (v *Verifier) applyThresholds(req Request, result Result) (Result, error) {
	if result.Score != nil && v.minScore >= 0 {
		if *result.Score < v.minScore {
			return result, fmt.Errorf(
				"%w: %s scored %.2f (minimum %.2f)",
				ErrScoreTooLow, req.Provider, *result.Score, v.minScore,
			)
		}
	}
	if req.Provider == ProviderRecaptcha &&
		result.Action != "" &&
		req.Scene.Valid() &&
		result.Action != req.Scene.Action() {
		return result, fmt.Errorf(
			"%w: %s token for %q submitted to %q",
			ErrActionMismatch, req.Provider, result.Action, req.Scene.Action(),
		)
	}
	return result, nil
}

// seen reports whether the token was already redeemed and still inside the TTL.
func (v *Verifier) seen(provider Provider, token string) bool {
	key := string(provider) + "\x00" + token
	now := v.now()

	v.mu.Lock()
	defer v.mu.Unlock()
	expires, ok := v.replay[key]
	if !ok {
		return false
	}
	if now.After(expires) {
		delete(v.replay, key)
		return false
	}
	return true
}

// remember records a redeemed token and prunes expired entries.
func (v *Verifier) remember(provider Provider, token string) {
	key := string(provider) + "\x00" + token
	now := v.now()

	v.mu.Lock()
	defer v.mu.Unlock()
	if len(v.replay) >= v.replaySize {
		for existing, expires := range v.replay {
			if now.After(expires) {
				delete(v.replay, existing)
			}
		}
	}
	v.replay[key] = now.Add(v.replayTTL)
}

// classifyTransportError separates "the provider did not answer" from "the token
// was refused". The distinction matters: a timeout is a 503 the visitor can retry,
// a refusal is a 400 the client must solve again.
func classifyTransportError(provider Provider, err error) error {
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, context.Canceled) ||
		(errors.As(err, &netErr) && netErr.Timeout()) {
		return fmt.Errorf("%w: %s: %v", ErrTimeout, provider, err)
	}
	return fmt.Errorf("%w: %s: %v", ErrUpstream, provider, err)
}

func defaultEndpoint(provider Provider) string {
	switch provider {
	case ProviderTurnstile:
		return endpointTurnstile
	case ProviderHCaptcha:
		return endpointHCaptcha
	default:
		return endpointRecaptcha
	}
}

// errorCodeList renders provider error codes for a log line. The codes are short
// fixed strings ("invalid-input-response"); the cap keeps a hostile endpoint from
// filling the log with a megabyte of text.
func errorCodeList(codes []string) string {
	if len(codes) == 0 {
		return "no error code"
	}
	trimmed := make([]string, 0, len(codes))
	for index, code := range codes {
		if index >= 5 {
			trimmed = append(trimmed, "…")
			break
		}
		if len(code) > 60 {
			code = code[:60]
		}
		trimmed = append(trimmed, code)
	}
	return strings.Join(trimmed, ",")
}
