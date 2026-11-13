package site

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// High threat operation re-authentication ("step-up").
//
// Deleting another account, rewriting one, resetting its second factor or wiping
// policy data is powerful enough that the session alone must not authorize it: the
// caller proves a password again, immediately before the operation. The proof is a
// short lived stateless token carried in StepUpHeaderName.
//
// The setting lives in the existing `site_configs` JSON document under its own
// `step_up` top level key. No table and no schema migration is introduced: the
// configuration document is already an opaque per-site blob, and the public/admin
// projections are built from the same bytes (see config.go).
const (
	// StepUpHeaderName is the request header carrying a step-up grant.
	StepUpHeaderName = "X-PP-Step-Up"
	// StepUpTokenTTL bounds how long one successful re-authentication is honored.
	// It is intentionally short: the grant exists for the one action that asked for
	// it, not as a second session.
	StepUpTokenTTL = 300 * time.Second
	// stepUpDocumentKey is the top level key of the stored site configuration.
	stepUpDocumentKey = "step_up"
	// maxStepUpPasswordBytes bounds the input to the password hasher. The policy
	// (length and complexity) that applies to login passwords is enforced where an
	// account password is created; this dedicated security password only has to be
	// non empty and small enough to hash cheaply.
	maxStepUpPasswordBytes = 128
)

// Step-up failures. They are sentinels so the transport can map them onto the
// documented problem reasons without matching on prose.
var (
	// ErrStepUpRequired means the caller must prove a password again before the
	// requested change is accepted. The API answers 403 `step_up_required`.
	ErrStepUpRequired = errors.New("site: step-up re-authentication required")
	// ErrStepUpUnavailable means this deployment was built without the password
	// hasher or the token signer the feature needs. It is a wiring error, not a
	// caller error, and must fail closed.
	ErrStepUpUnavailable = errors.New("site: step-up re-authentication is not configured")
)

// StepUpSettings is the stored `step_up` section of the site configuration.
//
// PasswordHash is the Argon2id PHC string of the optional dedicated security
// password. It never leaves the server: both the public projection and the
// administrator projection emit a mask instead (see SanitizeSiteConfigForAdmin).
type StepUpSettings struct {
	// Enabled reports whether the high threat routes require a fresh proof.
	Enabled bool `json:"enabled"`
	// PasswordHash is empty when no dedicated security password is set; account
	// login passwords then authorize the step-up step.
	PasswordHash string `json:"password_hash,omitempty"`
	// UpdatedAt is when the section last changed, for operator forensics.
	UpdatedAt time.Time `json:"updated_at"`
}

// StepUpStatus is the client facing, masked view of the settings.
type StepUpStatus struct {
	Enabled       bool
	PasswordSet   bool
	WindowSeconds int
}

// StepUpSettingsInput is one partial update of the settings.
//
// Enabled and Password are pointers so an omitted property stays unchanged;
// ClearPassword removes the dedicated security password. Setting a password and
// clearing it in the same request is refused as a malformed request.
type StepUpSettingsInput struct {
	Enabled       *bool
	Password      *string
	ClearPassword bool
}

// StepUpPasswordHasher hashes the dedicated security password. It is structurally
// satisfied by auth.PasswordHasher, which the composition root injects.
type StepUpPasswordHasher interface {
	Hash(ctx context.Context, plain string) (string, error)
	Verify(ctx context.Context, plain, encoded string) (bool, error)
}

// StepUpTokenVerifier verifies one step-up grant for exactly one account on one
// site. It is structurally satisfied by auth.StepUpSigner.
type StepUpTokenVerifier interface {
	Verify(raw, userID, siteID string) bool
}

// WithStepUpPasswordHasher injects the password hasher used to store a dedicated
// security password.
func WithStepUpPasswordHasher(hasher StepUpPasswordHasher) Option {
	return func(s *Service) { s.stepUpHasher = hasher }
}

// WithStepUpTokens injects the token verifier that checks X-PP-Step-Up grants.
func WithStepUpTokens(tokens StepUpTokenVerifier) Option {
	return func(s *Service) { s.stepUpTokens = tokens }
}

// StepUpStatus returns the masked step-up settings of a site to its administrator.
//
// The caller must hold `manage_site` on the site. A site that never saved a
// configuration answers protection off, which is the documented default.
func (s *Service) StepUpStatus(ctx context.Context, actor Member, siteID string) (StepUpStatus, error) {
	if err := authorize(actor, siteID, ActionManageSite); err != nil {
		return StepUpStatus{}, err
	}
	settings, _, err := s.stepUpSettings(ctx, siteID)
	if err != nil {
		return StepUpStatus{}, err
	}
	return stepUpStatusOf(settings), nil
}

// UpdateStepUpSettings changes the step-up protection of a site.
//
// The first write of a fresh site (protection off and no dedicated password yet)
// is allowed without a grant: enabling protection for the first time cannot be a
// privilege escalation, because the caller can already administer the site. Every
// later change requires a valid X-PP-Step-Up grant minted for the caller on this
// site, which is what makes disabling the protection or replacing the dedicated
// password an explicit re-authentication.
func (s *Service) UpdateStepUpSettings(
	ctx context.Context,
	actor Member,
	siteID string,
	in StepUpSettingsInput,
	rawToken string,
	requestID string,
) (StepUpStatus, error) {
	if err := authorize(actor, siteID, ActionManageSite); err != nil {
		return StepUpStatus{}, err
	}
	if in.Password != nil && in.ClearPassword {
		return StepUpStatus{}, formatInvalid("password and clear_password are mutually exclusive")
	}

	current, stored, err := s.stepUpSettings(ctx, siteID)
	if err != nil {
		return StepUpStatus{}, err
	}

	// A site that already protects itself (enabled or with a dedicated password)
	// only accepts a change proven by a fresh password check.
	if current.Enabled || current.PasswordHash != "" {
		if s.stepUpTokens == nil || !s.stepUpTokens.Verify(rawToken, actor.UserID, siteID) {
			return StepUpStatus{}, ErrStepUpRequired
		}
	}

	next := current
	if in.Enabled != nil {
		next.Enabled = *in.Enabled
	}
	if in.Password != nil {
		password := *in.Password
		if password == "" {
			return StepUpStatus{}, formatInvalid("password must not be empty; use clear_password to remove it")
		}
		if len(password) > maxStepUpPasswordBytes {
			return StepUpStatus{}, formatInvalid(
				fmt.Sprintf("password exceeds %d characters", maxStepUpPasswordBytes))
		}
		if s.stepUpHasher == nil {
			return StepUpStatus{}, ErrStepUpUnavailable
		}
		hash, hashErr := s.stepUpHasher.Hash(ctx, password)
		if hashErr != nil {
			return StepUpStatus{}, hashErr
		}
		next.PasswordHash = hash
	}
	if in.ClearPassword {
		next.PasswordHash = ""
	}
	next.UpdatedAt = s.now()

	document, err := withStepUpSettings(stored.Document, next)
	if err != nil {
		return StepUpStatus{}, err
	}
	if err := validateSiteConfigDocument(document); err != nil {
		return StepUpStatus{}, err
	}

	if s.repo == nil {
		return StepUpStatus{}, ErrStepUpUnavailable
	}
	if _, err := s.repo.SaveSiteConfig(
		ctx,
		siteID,
		SiteConfigInput{Document: document, ExpectedRevision: stored.Revision},
		AuditEntry{
			SiteID:    siteID,
			ActorID:   actor.UserID,
			Action:    "site.stepup.updated",
			Target:    siteID,
			RequestID: requestID,
			// Neither the password nor its hash is ever recorded: the audit trail
			// states the resulting switches only.
			Detail: map[string]any{
				"enabled":      next.Enabled,
				"password_set": next.PasswordHash != "",
			},
			At: s.now(),
		},
	); err != nil {
		return StepUpStatus{}, err
	}
	return stepUpStatusOf(next), nil
}

// StepUpEnabled reports whether the site requires a step-up grant.
//
// The guard reads it on every protected request; a site without a stored
// configuration is simply unprotected.
func (s *Service) StepUpEnabled(ctx context.Context, siteID string) (bool, error) {
	settings, _, err := s.stepUpSettings(ctx, siteID)
	if err != nil {
		return false, err
	}
	return settings.Enabled, nil
}

// StepUpPasswordHash returns the dedicated security password hash of a site.
//
// It exists for the authentication service, which checks it before falling back
// to the caller's account login password. The hash is never exposed over HTTP.
func (s *Service) StepUpPasswordHash(ctx context.Context, siteID string) (string, error) {
	settings, _, err := s.stepUpSettings(ctx, siteID)
	if err != nil {
		return "", err
	}
	return settings.PasswordHash, nil
}

// VerifyStepUpToken reports whether raw is a valid grant for this account/site.
func (s *Service) VerifyStepUpToken(raw, userID, siteID string) bool {
	if s.stepUpTokens == nil {
		return false
	}
	return s.stepUpTokens.Verify(raw, userID, siteID)
}

// stepUpSettings loads the stored section together with the configuration row it
// came from, so a write can use the row as its revision precondition.
func (s *Service) stepUpSettings(ctx context.Context, siteID string) (StepUpSettings, SiteConfig, error) {
	if siteID == "" || s.repo == nil {
		return StepUpSettings{}, SiteConfig{}, ErrNotFound
	}
	stored, err := s.repo.SiteConfig(ctx, siteID)
	if err != nil {
		if errors.Is(err, ErrSiteConfigNotFound) {
			return StepUpSettings{}, SiteConfig{}, nil
		}
		return StepUpSettings{}, SiteConfig{}, err
	}
	settings, err := stepUpSettingsOf(stored.Document)
	if err != nil {
		return StepUpSettings{}, SiteConfig{}, err
	}
	return settings, stored, nil
}

// stepUpStatusOf projects stored settings onto the client facing view.
func stepUpStatusOf(settings StepUpSettings) StepUpStatus {
	return StepUpStatus{
		Enabled:       settings.Enabled,
		PasswordSet:   settings.PasswordHash != "",
		WindowSeconds: int(StepUpTokenTTL / time.Second),
	}
}

// stepUpSettingsOf extracts the `step_up` section of a stored configuration.
//
// A missing key is protection off. A malformed section is an error: silently
// reading a corrupt record as "off" would quietly disable a security control.
func stepUpSettingsOf(document []byte) (StepUpSettings, error) {
	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 {
		return StepUpSettings{}, nil
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &doc); err != nil {
		return StepUpSettings{}, fmt.Errorf("%w: stored configuration is not a JSON object", ErrInvalidInput)
	}
	raw, ok := doc[stepUpDocumentKey]
	if !ok {
		return StepUpSettings{}, nil
	}
	var settings StepUpSettings
	if err := json.Unmarshal(raw, &settings); err != nil {
		return StepUpSettings{}, fmt.Errorf("%w: stored step-up settings are malformed", ErrInvalidInput)
	}
	return settings, nil
}

// withStepUpSettings replaces the `step_up` section of a configuration document,
// keeping every other top level key untouched.
func withStepUpSettings(document []byte, settings StepUpSettings) ([]byte, error) {
	doc := map[string]json.RawMessage{}
	if trimmed := bytes.TrimSpace(document); len(trimmed) != 0 {
		if err := json.Unmarshal(trimmed, &doc); err != nil {
			return nil, fmt.Errorf("%w: stored configuration is not a JSON object", ErrInvalidInput)
		}
		if doc == nil {
			doc = map[string]json.RawMessage{}
		}
	}
	encoded, err := json.Marshal(settings)
	if err != nil {
		return nil, fmt.Errorf("%w: encode step-up settings: %v", ErrInvalidInput, err)
	}
	doc[stepUpDocumentKey] = encoded
	return json.Marshal(doc)
}

// stripStepUpSection removes the server owned `step_up` section from a document a
// client sent to PUT /sites/{siteID}/site-config.
//
// The setting has its own endpoint and its own re-authentication rule, so a client
// save must not be able to write it (or erase it by round-tripping a masked
// projection). The store merges the section back from the stored document when the
// incoming document omits it.
func stripStepUpSection(document []byte) ([]byte, error) {
	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 {
		return document, nil
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &doc); err != nil {
		return nil, fmt.Errorf("%w: document is not valid JSON", ErrInvalidInput)
	}
	if _, ok := doc[stepUpDocumentKey]; !ok {
		return document, nil
	}
	delete(doc, stepUpDocumentKey)
	encoded, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("%w: encode site configuration: %v", ErrInvalidInput, err)
	}
	return encoded, nil
}

// stepUpProjection is the masked section an administrator reads back.
//
// The hash is deliberately absent: even an administrator's own client must never
// receive a credential that could be replayed against Verify.
type stepUpProjection struct {
	Enabled     bool `json:"enabled"`
	PasswordSet bool `json:"password_set"`
}

// SanitizeSiteConfigForAdmin builds the administrator projection of a stored
// configuration: the full document with the `step_up` section reduced to its two
// non sensitive switches. It is the read side counterpart of stripStepUpSection.
func SanitizeSiteConfigForAdmin(document []byte) ([]byte, error) {
	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 {
		return []byte("{}"), nil
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &doc); err != nil {
		return nil, fmt.Errorf("%w: stored configuration is not a JSON object", ErrInvalidInput)
	}
	if doc == nil {
		doc = map[string]json.RawMessage{}
	}
	settings, err := stepUpSettingsOf(trimmed)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(stepUpProjection{
		Enabled:     settings.Enabled,
		PasswordSet: settings.PasswordHash != "",
	})
	if err != nil {
		return nil, err
	}
	doc[stepUpDocumentKey] = encoded
	return json.Marshal(doc)
}
