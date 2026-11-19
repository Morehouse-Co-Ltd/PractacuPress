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
// tests and a self-hosted gateway can point at a fake. The local provider has no
// endpoint: its tokens are redeemed against an in-process LocalStore.
const (
	endpointTurnstile = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	endpointHCaptcha  = "https://api.hcaptcha.com/siteverify"
)

// Defaults for the verifier. The timeout is deliberately short: a login should not
// hang for the provider's full patience, and a slow siteverify is a failed check.
const (
	DefaultTimeout    = 5 * time.Second
	DefaultReplayTTL  = 10 * time.Minute
	DefaultReplaySize = 4096
	// maxResponseBytes bounds the siteverify body. Every provider answers with a
	// small JSON object; anything larger is a broken endpoint or a hostile proxy.
	maxResponseBytes = 64 << 10
)

// Config configures a Verifier.
type Config struct {
	// Secrets maps each third party provider to the server secret. An empty or
	// missing entry means that provider is not configured, and the guard treats a
	// site that selected it as unenforced rather than silently passing.
	Secrets map[Provider]string
	// Endpoints overrides the provider siteverify URL per provider. Tests point
	// this at an httptest server; production leaves it empty.
	Endpoints map[Provider]string
	// Local is the in-process challenge store behind ProviderLocal. Nil means the
	// local provider is not available in this process (and is reported as
	// unconfigured, exactly like a third party provider without a secret).
	Local *LocalStore
	// HTTPClient performs the siteverify call. Nil uses an http.Client with
	// Timeout.
	HTTPClient *http.Client
	// Timeout bounds one verification. Zero uses DefaultTimeout.
	Timeout time.Duration
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
	// Scene is the protected form. A local token is bound to it; Turnstile widgets
	// may carry it as their action.
	Scene Scene
}

// Verifier redeems challenge tokens against a provider's siteverify endpoint or,
// for the local provider, against the in-process challenge store.
type Verifier struct {
	secrets   map[Provider]string
	endpoints map[Provider]string
	local     *LocalStore
	client    *http.Client
	timeout   time.Duration
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
		local:      cfg.Local,
		client:     client,
		timeout:    timeout,
		logger:     logger,
		now:        now,
		replayTTL:  replayTTL,
		replaySize: replaySize,
		replay:     make(map[string]time.Time),
	}
}

// Configured reports whether the process can verify p.
//
// The local provider is configured when the in-memory store is wired; it needs no
// secret. A third party provider is configured when a secret was supplied.
func (v *Verifier) Configured(p Provider) bool {
	if p == ProviderLocal {
		return v.local != nil
	}
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
// A token is accepted at most once. For third party providers the replay table is
// what turns the provider's "this token was already solved" guarantee into a server
// side one: without it a captured token could be submitted to the same endpoint
// twice before the provider noticed, and both requests would look valid. The local
// provider's store consumes the token on redemption, so it needs no second table.
func (v *Verifier) Verify(ctx context.Context, req Request) (Result, error) {
	if !req.Provider.Valid() {
		return Result{}, fmt.Errorf("%w: %q", ErrProviderUnknown, req.Provider)
	}
	if req.Provider == ProviderLocal {
		if v.local == nil {
			return Result{}, fmt.Errorf("%w: %s", ErrNotConfigured, req.Provider)
		}
		return v.local.Redeem(req.Token, req.Scene)
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

	v.remember(req.Provider, token)
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
		return ""
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
