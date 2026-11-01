package site

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
)

// MaxCustomizationBytes bounds one design document.
//
// A site with a few dozen pages of block JSON stays well under a megabyte; the cap
// exists so one authenticated write cannot fill the database, and so a runaway client
// fails loudly instead of slowly.
const MaxCustomizationBytes = 1 << 20

// Customization returns the saved design document of a site.
//
// No actor is involved on purpose: who may read a design is a transport concern, and the
// handler answers it from the site's visibility mode. The same split is used by the
// public author profile.
func (s *Service) Customization(ctx context.Context, siteID string) (Customization, error) {
	if siteID == "" {
		return Customization{}, ErrNotFound
	}
	return s.repo.Customization(ctx, siteID)
}

// SaveCustomization validates and stores a site's design document.
//
// The document is opaque JSON: validated as a JSON object, size capped, and otherwise
// passed through untouched. Interpreting it here would make every block property a
// server release.
func (s *Service) SaveCustomization(
	ctx context.Context,
	actor Member,
	siteID string,
	document []byte,
	expectedRevision int,
	requestID string,
) (Customization, error) {
	if err := authorize(actor, siteID, ActionManageSite); err != nil {
		return Customization{}, err
	}
	if err := validateCustomizationDocument(document); err != nil {
		return Customization{}, err
	}
	if expectedRevision < 0 {
		return Customization{}, fmt.Errorf("%w: revision must not be negative", ErrInvalidInput)
	}

	saved, err := s.repo.SaveCustomization(
		ctx,
		siteID,
		CustomizationInput{Document: document, ExpectedRevision: expectedRevision},
		AuditEntry{
			SiteID:    siteID,
			ActorID:   actor.UserID,
			Action:    "site.customization.updated",
			Target:    siteID,
			RequestID: requestID,
			// The audit trail records what changed shape-wise, never the document: a
			// page tree belongs in the design table, not in the operator log.
			Detail: map[string]any{
				"bytes":    len(document),
				"revision": expectedRevision + 1,
			},
			At: s.now(),
		},
	)
	if err != nil {
		return Customization{}, err
	}
	return saved, nil
}

// validateCustomizationDocument rejects anything that is not a JSON object within the
// size cap.
//
// The object requirement matters: an array or a scalar would still be valid JSON, but the
// frontend normaliser expects an object and would silently fall back to defaults, which
// looks like data loss to the operator who just saved.
func validateCustomizationDocument(document []byte) error {
	if len(document) == 0 {
		return fmt.Errorf("%w: document is empty", ErrInvalidInput)
	}
	if len(document) > MaxCustomizationBytes {
		return fmt.Errorf("%w: document exceeds %d bytes", ErrCustomizationTooLarge, MaxCustomizationBytes)
	}

	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fmt.Errorf("%w: document must be a JSON object", ErrInvalidInput)
	}
	if !json.Valid(trimmed) {
		return fmt.Errorf("%w: document is not valid JSON", ErrInvalidInput)
	}
	return nil
}
