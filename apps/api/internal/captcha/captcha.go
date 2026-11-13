// Package captcha verifies human-challenge tokens (Cloudflare Turnstile,
// hCaptcha and Google reCAPTCHA) and decides which site forms require one.
//
// The package is transport agnostic: it names the protected scenes, reads the
// site's intent from the stored design document, calls the provider's siteverify
// endpoint and reports sentinel errors. Mapping those errors onto HTTP status
// codes and problem+json lives in the handlers, exactly like every other module.
//
// Two boundaries are deliberate:
//
//   - The secret never leaves the process. It is read from the environment at
//     startup (see Config.Secrets) and sent only to the provider's siteverify
//     endpoint, never to the browser and never stored in the site configuration.
//   - The stored site configuration holds the *intent* (which provider, which
//     forms, the public site key). Whether that intent is enforced is decided
//     here from the server's own secret, so a site that switched the switch on
//     without configuring the secret is reported as unenforced instead of
//     silently pretending to check tokens.
package captcha

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Provider is one of the supported challenge services.
type Provider string

// The providers the frontend can select.
const (
	ProviderTurnstile Provider = "turnstile"
	ProviderHCaptcha  Provider = "hcaptcha"
	ProviderRecaptcha Provider = "recaptcha"
)

// Providers lists every accepted provider in the order the settings page shows them.
var Providers = []Provider{ProviderTurnstile, ProviderHCaptcha, ProviderRecaptcha}

// Valid reports whether p is a known provider.
func (p Provider) Valid() bool {
	switch p {
	case ProviderTurnstile, ProviderHCaptcha, ProviderRecaptcha:
		return true
	default:
		return false
	}
}

// Label is the operator facing name of a provider.
func (p Provider) Label() string {
	switch p {
	case ProviderTurnstile:
		return "Cloudflare Turnstile"
	case ProviderHCaptcha:
		return "hCaptcha"
	case ProviderRecaptcha:
		return "Google reCAPTCHA"
	default:
		return string(p)
	}
}

// Scene names one protected form. The value doubles as the reCAPTCHA v3 action:
// the widget is told to run with this action and the server refuses a token whose
// action does not match, which is what keeps a token harvested on one form from
// being replayed on another.
type Scene string

// The protected scenes.
const (
	SceneLogin         Scene = "login"
	SceneRegister      Scene = "register"
	ScenePasswordReset Scene = "password_reset"
	SceneComment       Scene = "comment"
)

// Valid reports whether s is a known scene.
func (s Scene) Valid() bool {
	switch s {
	case SceneLogin, SceneRegister, ScenePasswordReset, SceneComment:
		return true
	default:
		return false
	}
}

// Action is the reCAPTCHA v3 action a widget must execute for this scene.
func (s Scene) Action() string { return string(s) }

// Settings is the site's stored intent, mirroring the frontend
// `HumanVerificationSettings` stored under `verification` in the design document.
type Settings struct {
	Enabled         bool
	Provider        Provider
	SiteKey         string
	OnLogin         bool
	OnRegister      bool
	OnPasswordReset bool
	OnComment       bool
}

// SceneEnabled reports whether the operator asked for a challenge on scene.
func (s Settings) SceneEnabled(scene Scene) bool {
	switch scene {
	case SceneLogin:
		return s.OnLogin
	case SceneRegister:
		return s.OnRegister
	case ScenePasswordReset:
		return s.OnPasswordReset
	case SceneComment:
		return s.OnComment
	default:
		return false
	}
}

// DefaultSettings is the intent of a site that never saved the section: off.
//
// The per-scene defaults mirror the old settings document, which had no
// `on_password_reset` switch: an upgrade must not silently start challenging the
// reset form on a site that only ever protected login and registration. The
// frontend writes the switch explicitly on the next save.
func DefaultSettings() Settings {
	return Settings{
		Enabled:         false,
		Provider:        ProviderTurnstile,
		OnLogin:         true,
		OnRegister:      true,
		OnPasswordReset: false,
		OnComment:       false,
	}
}

// settingsDocument is the stored shape. Every switch is a pointer so an omitted
// field is distinguishable from an explicit false; older documents written before
// this feature only carry a subset.
type settingsDocument struct {
	Enabled         *bool  `json:"enabled"`
	Provider        string `json:"provider"`
	SiteKey         string `json:"site_key"`
	OnLogin         *bool  `json:"on_login"`
	OnRegister      *bool  `json:"on_register"`
	OnComment       *bool  `json:"on_comment"`
	OnPasswordReset *bool  `json:"on_password_reset"`
}

// customizationDocument is the slice of the design document this package reads.
//
// The design document is opaque to the API (see site.SaveCustomization), so the
// captcha policy is parsed out of it here instead of growing a second store: the
// settings page already saves the intent there, and one source of truth cannot
// disagree with itself.
type customizationDocument struct {
	Verification *settingsDocument `json:"verification"`
}

// maxSiteKeyCharacters bounds the public site key. Provider keys are far shorter;
// the cap only keeps a runaway document from being echoed back by the status
// endpoint.
const maxSiteKeyCharacters = 200

// ParseSettings reads the `verification` section of a stored design document.
//
// A missing section, invalid JSON or unknown provider means "not enabled": the
// safe reading of a document this feature cannot understand is to protect
// nothing rather than to lock every visitor out of the site.
func ParseSettings(document []byte) Settings {
	settings := DefaultSettings()
	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return settings
	}
	var doc customizationDocument
	if err := json.Unmarshal(trimmed, &doc); err != nil {
		return settings
	}
	stored := doc.Verification
	if stored == nil {
		return settings
	}

	if stored.Enabled != nil {
		settings.Enabled = *stored.Enabled
	}
	if stored.OnLogin != nil {
		settings.OnLogin = *stored.OnLogin
	}
	if stored.OnRegister != nil {
		settings.OnRegister = *stored.OnRegister
	}
	if stored.OnComment != nil {
		settings.OnComment = *stored.OnComment
	}
	if stored.OnPasswordReset != nil {
		settings.OnPasswordReset = *stored.OnPasswordReset
	}

	if provider := Provider(strings.TrimSpace(stored.Provider)); provider.Valid() {
		settings.Provider = provider
	} else if stored.Provider != "" {
		// An unknown provider is not a reason to guess: a site that saved one
		// cannot be verified by any client, so it must read as off.
		settings.Enabled = false
	}
	if len([]rune(stored.SiteKey)) <= maxSiteKeyCharacters {
		settings.SiteKey = strings.TrimSpace(stored.SiteKey)
	}
	return settings
}

// Policy is the effective rule the server enforces for one site.
//
// Effective is the only field a form should trust: intent without a server secret
// cannot be enforced, and rendering a widget for a rule that is not applied would
// teach visitors that the check is decorative.
type Policy struct {
	Settings Settings
	// SecretConfigured reports whether the process holds a secret for the
	// provider the site selected.
	SecretConfigured bool
	// Effective is true when the check really runs: the site enabled it, the
	// provider secret is configured and a public site key is present.
	Effective bool
}

// SceneEnforced reports whether scene really requires a token.
func (p Policy) SceneEnforced(scene Scene) bool {
	return p.Effective && p.Settings.SceneEnabled(scene)
}

// Scenes renders the enforced scenes for the status endpoint.
func (p Policy) Scenes() map[string]bool {
	return map[string]bool{
		string(SceneLogin):         p.SceneEnforced(SceneLogin),
		string(SceneRegister):      p.SceneEnforced(SceneRegister),
		string(ScenePasswordReset): p.SceneEnforced(ScenePasswordReset),
		string(SceneComment):       p.SceneEnforced(SceneComment),
	}
}

// Sentinel failures. Handlers translate these into problem+json; the free text
// of the wrapped error is for operators and never reaches the client verbatim.
var (
	// ErrNotConfigured means the selected provider has no server secret.
	ErrNotConfigured = errors.New("captcha: provider secret is not configured")
	// ErrTokenMissing means the protected form submitted no token at all.
	ErrTokenMissing = errors.New("captcha: token is missing")
	// ErrRejected means the provider refused the token.
	ErrRejected = errors.New("captcha: token was rejected")
	// ErrReplay means the same token was already redeemed.
	ErrReplay = errors.New("captcha: token was already redeemed")
	// ErrScoreTooLow means a reCAPTCHA v3 score fell below the threshold.
	ErrScoreTooLow = errors.New("captcha: score is below the threshold")
	// ErrActionMismatch means a reCAPTCHA v3 token was issued for another form.
	ErrActionMismatch = errors.New("captcha: action does not match the protected form")
	// ErrTimeout means the siteverify call did not answer in time.
	ErrTimeout = errors.New("captcha: verification timed out")
	// ErrUpstream means the provider answered with an error or a non 200 status.
	ErrUpstream = errors.New("captcha: verification service is unavailable")
	// ErrPolicyUnavailable means the site's stored intent could not be read.
	ErrPolicyUnavailable = errors.New("captcha: site policy is unavailable")
	// ErrSceneUnknown means a caller asked about a scene this package does not know.
	// It is a programming error, never a visitor one.
	ErrSceneUnknown = errors.New("captcha: unknown protected scene")
)

// Reason classifies a failure into the stable `details.reason` vocabulary the
// frontend translates. It is total: an unknown error still yields a reason.
func Reason(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrTokenMissing):
		return "captcha_required"
	case errors.Is(err, ErrReplay):
		return "captcha_replayed"
	case errors.Is(err, ErrScoreTooLow):
		return "captcha_score_too_low"
	case errors.Is(err, ErrActionMismatch):
		return "captcha_action_mismatch"
	case errors.Is(err, ErrRejected):
		return "captcha_invalid"
	case errors.Is(err, ErrNotConfigured):
		return "captcha_not_configured"
	case errors.Is(err, ErrTimeout), errors.Is(err, ErrUpstream):
		return "captcha_unavailable"
	case errors.Is(err, ErrPolicyUnavailable):
		return "captcha_policy_unavailable"
	default:
		return "captcha_failed"
	}
}

// ErrProviderUnknown marks a settings value this process cannot verify.
var ErrProviderUnknown = errors.New("captcha: unknown provider")

// redactToken keeps a token out of logs and audit rows. Only the length and a
// short prefix survive, which is enough to correlate a report with a provider
// dashboard without storing a redeemable value.
func redactToken(token string) string {
	if len(token) <= 8 {
		return fmt.Sprintf("len=%d", len(token))
	}
	return fmt.Sprintf("%s… len=%d", token[:6], len(token))
}
