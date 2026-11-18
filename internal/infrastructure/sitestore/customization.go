package sitestore

import (
	"context"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/sitecustomization"
	"github.com/practacu/practacu-press/internal/site"
)

// Customization returns the saved design document of one site.
func (s *Store) Customization(ctx context.Context, siteID string) (site.Customization, error) {
	row, err := s.client.SiteCustomization.Query().
		Where(sitecustomization.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return site.Customization{}, site.ErrCustomizationNotFound
		}
		return site.Customization{}, err
	}
	return toCustomization(row), nil
}

// SaveCustomization upserts the design document and records the audit entry in the same
// transaction.
//
// The write is a conditional UPDATE rather than read-then-write: two tabs saving at the
// same moment would otherwise both read revision 3, both write 4, and one edit would
// vanish without anyone noticing. When the precondition matches no row the row is either
// absent (first save) or was changed by someone else (conflict), and the caller is told
// which.
func (s *Store) SaveCustomization(
	ctx context.Context,
	siteID string,
	in site.CustomizationInput,
	audit site.AuditEntry,
) (site.Customization, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return site.Customization{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	affected, err := tx.SiteCustomization.Update().
		Where(
			sitecustomization.SiteIDEQ(siteID),
			sitecustomization.RevisionEQ(in.ExpectedRevision),
		).
		SetDocument(string(in.Document)).
		AddRevision(1).
		Save(ctx)
	if err != nil {
		return site.Customization{}, err
	}

	if affected == 0 {
		exists, err := tx.SiteCustomization.Query().
			Where(sitecustomization.SiteIDEQ(siteID)).
			Exist(ctx)
		if err != nil {
			return site.Customization{}, err
		}
		if exists {
			// The document changed since the caller last saw it.
			return site.Customization{}, site.ErrCustomizationConflict
		}
		if in.ExpectedRevision > 0 {
			// The caller expected a document that is no longer there; recreating it
			// silently would resurrect a design someone deliberately discarded.
			return site.Customization{}, site.ErrCustomizationConflict
		}
		if _, err := tx.SiteCustomization.Create().
			SetSiteID(siteID).
			SetDocument(string(in.Document)).
			SetRevision(1).
			Save(ctx); err != nil {
			return site.Customization{}, err
		}
	}

	saved, err := tx.SiteCustomization.Query().
		Where(sitecustomization.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		return site.Customization{}, err
	}

	if err := insertAudit(ctx, tx.Client(), audit, "site_customization", siteID); err != nil {
		return site.Customization{}, err
	}

	if err := tx.Commit(); err != nil {
		return site.Customization{}, err
	}
	committed = true

	return toCustomization(saved), nil
}

// toCustomization maps a generated row onto the domain type.
func toCustomization(row *entgen.SiteCustomization) site.Customization {
	return site.Customization{
		Document:  []byte(row.Document),
		Revision:  row.Revision,
		UpdatedAt: row.UpdatedAt.UTC(),
	}
}
