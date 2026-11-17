// Package sms delivers phone verification codes through a pluggable gateway.
//
// The package mirrors platform/mailer on purpose: an SMS gateway is an optional
// capability of the process, so an unconfigured deployment reports itself as such
// instead of pretending a code was delivered. Three providers exist and no more:
//
//   - off  no gateway at all. sms.New returns nil, which disables phone login.
//   - log  writes the code to the structured process log. Development only: it is
//     how a developer reads the code without paying a carrier.
//   - http posts a small JSON document to an operator supplied webhook, optionally
//     with a bearer token. This is the contract A gateway shape.
//
// The interface is deliberately tiny. Callers only need "can this deployment send
// a code" and "send this one"; everything else (rate limiting, expiry, attempts)
// belongs to the auth module that owns the phone_codes rows.
package sms

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Provider names accepted by SMS_PROVIDER (contract A).
const (
	// ProviderOff disables the feature. It is the default.
	ProviderOff = "off"
	// ProviderLog writes the code to the process log. Development only.
	ProviderLog = "log"
	// ProviderHTTP posts the code to SMS_HTTP_URL.
	ProviderHTTP = "http"
)

// Delivery bounds. A stuck gateway must never hold a login request open.
const (
	// defaultTimeout bounds one delivery attempt when Config.Timeout is zero.
	defaultTimeout = 10 * time.Second
	// maxErrorBody bounds how much of a gateway error body is quoted in the error.
	// The body is not user input, but it is still upstream text: keeping it short
	// stops a misconfigured gateway from flooding the logs.
	maxErrorBody = 256
)

// Message is one outbound verification code.
type Message struct {
	// Phone is the normalized phone number (E.164 or 11 digit domestic form).
	Phone string
	// Code is the 6 digit verification code.
	Code string
	// Purpose is "login" or "register"; a gateway may pick a template by it.
	Purpose string
	// TTL is how long the code stays valid.
	TTL time.Duration
}

// Sender delivers a message.
//
// Configured is part of the contract because the endpoint set reports itself as
// unavailable when no gateway is wired: a 202 for a code nobody can receive would
// be a lie.
type Sender interface {
	Send(ctx context.Context, msg Message) error
	Configured() bool
}

// Config describes the selected gateway.
type Config struct {
	// Provider is one of the Provider* values. Empty means ProviderOff.
	Provider string
	// URL is the webhook address of the http provider.
	URL string
	// Token, when set, is sent as an Authorization: Bearer header.
	Token string
	// Timeout bounds one delivery attempt. Zero means defaultTimeout.
	Timeout time.Duration
	// Logger receives the log provider output and delivery failures. Nil uses
	// slog.Default().
	Logger *slog.Logger
}

// New returns the Sender selected by cfg.Provider.
//
// A nil Sender and a nil error mean "no gateway": that is the off case, which the
// caller reports as sms_not_configured instead of accepting a code it cannot send.
func New(cfg Config) (Sender, error) {
	provider := strings.ToLower(strings.TrimSpace(cfg.Provider))
	switch provider {
	case "", ProviderOff:
		return nil, nil
	case ProviderLog:
		logger := cfg.Logger
		if logger == nil {
			logger = slog.Default()
		}
		return &logSender{logger: logger}, nil
	case ProviderHTTP:
		endpoint := strings.TrimSpace(cfg.URL)
		if endpoint == "" {
			return nil, errors.New("sms: SMS_HTTP_URL is required when SMS_PROVIDER=http")
		}
		parsed, err := url.Parse(endpoint)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return nil, errors.New("sms: SMS_HTTP_URL must be an absolute http or https URL")
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return nil, errors.New("sms: SMS_HTTP_URL must use http or https")
		}
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = defaultTimeout
		}
		return &httpSender{
			endpoint: endpoint,
			token:    strings.TrimSpace(cfg.Token),
			client:   &http.Client{Timeout: timeout},
		}, nil
	default:
		return nil, fmt.Errorf("sms: unsupported provider %q", cfg.Provider)
	}
}

// logSender writes the code to the process log.
//
// It is the development provider. The phone number is masked so a log file does
// not become a contact list, but the code is written verbatim: that is the whole
// point of the provider.
type logSender struct {
	logger *slog.Logger
}

var _ Sender = (*logSender)(nil)

// Configured reports true: a constructed log sender is a usable development gateway.
func (s *logSender) Configured() bool { return s != nil }

// Send logs one code.
func (s *logSender) Send(ctx context.Context, msg Message) error {
	if s == nil || s.logger == nil {
		return errors.New("sms: no logger configured")
	}
	if strings.TrimSpace(msg.Phone) == "" || strings.TrimSpace(msg.Code) == "" {
		return errors.New("sms: phone and code are required")
	}
	s.logger.InfoContext(ctx, "sms verification code (log provider)",
		"phone", MaskPhone(msg.Phone),
		"purpose", msg.Purpose,
		"code", msg.Code,
		"ttl_seconds", int(msg.TTL.Seconds()),
	)
	return nil
}

// httpSender posts the code to an operator configured webhook.
type httpSender struct {
	endpoint string
	token    string
	client   *http.Client
}

var _ Sender = (*httpSender)(nil)

// Configured reports true: a constructed HTTP sender has its endpoint.
func (s *httpSender) Configured() bool { return s != nil && s.endpoint != "" }

// httpPayload is the contract A request body: {phone, code, purpose, ttl}.
type httpPayload struct {
	Phone   string `json:"phone"`
	Code    string `json:"code"`
	Purpose string `json:"purpose"`
	TTL     int    `json:"ttl"`
}

// Send delivers one code.
//
// Any non 2xx answer is an error: silently accepting a rejected code would leave
// the visitor waiting for an SMS that never arrives.
func (s *httpSender) Send(ctx context.Context, msg Message) error {
	if !s.Configured() {
		return errors.New("sms: no gateway configured")
	}
	if strings.TrimSpace(msg.Phone) == "" || strings.TrimSpace(msg.Code) == "" {
		return errors.New("sms: phone and code are required")
	}

	body, err := json.Marshal(httpPayload{
		Phone:   msg.Phone,
		Code:    msg.Code,
		Purpose: msg.Purpose,
		TTL:     int(msg.TTL.Seconds()),
	})
	if err != nil {
		return fmt.Errorf("sms: encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("sms: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("sms: deliver code: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return fmt.Errorf("sms: gateway answered %d: %s",
			resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	// Drain the body so the connection can be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	return nil
}

// MaskPhone hides the middle of a number for display and logs.
//
// "13800138000" becomes "138****8000"; a shorter number keeps only its last two
// digits. It is best effort on purpose: the caller owns the real masking rule that
// is persisted (auth.PhoneMasked), this only keeps log lines usable.
func MaskPhone(phone string) string {
	digits := []rune(phone)
	if len(digits) <= 4 {
		return strings.Repeat("*", len(digits))
	}
	if len(digits) <= 7 {
		return string(digits[:2]) + strings.Repeat("*", len(digits)-4) + string(digits[len(digits)-2:])
	}
	head := string(digits[:3])
	tail := string(digits[len(digits)-4:])
	return head + "****" + tail
}
