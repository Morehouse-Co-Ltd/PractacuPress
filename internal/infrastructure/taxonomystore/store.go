// Package taxonomystore implements the taxonomy persistence port with Ent.
package taxonomystore

import (
	"context"

	"github.com/practacu/practacu-press/internal/taxonomy"

	entgen "github.com/practacu/practacu-press/ent"
	"github.com/practacu/practacu-press/ent/contentitem"
	"github.com/practacu/practacu-press/ent/taxonomyterm"
)

// Store is the Ent backed implementation of taxonomy.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ taxonomy.Repository = (*Store)(nil)

// List returns every term of a site ordered by kind and name.
func (s *Store) List(ctx context.Context, siteID string) ([]taxonomy.Term, error) {
	rows, err := s.client.TaxonomyTerm.Query().
		Where(taxonomyterm.SiteIDEQ(siteID)).
		Order(entgen.Asc(taxonomyterm.FieldKind, taxonomyterm.FieldName, taxonomyterm.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}

	terms := make([]taxonomy.Term, 0, len(rows))
	for _, row := range rows {
		terms = append(terms, toTerm(row))
	}
	return terms, nil
}

// FindByID loads one term inside a site scope.
func (s *Store) FindByID(ctx context.Context, siteID, termID string) (taxonomy.Term, error) {
	row, err := s.client.TaxonomyTerm.Query().
		Where(taxonomyterm.IDEQ(termID), taxonomyterm.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return taxonomy.Term{}, taxonomy.ErrNotFound
		}
		return taxonomy.Term{}, err
	}
	return toTerm(row), nil
}

// Insert stores a new term.
func (s *Store) Insert(ctx context.Context, term taxonomy.Term) (taxonomy.Term, error) {
	row, err := s.client.TaxonomyTerm.Create().
		SetSiteID(term.SiteID).
		SetKind(string(term.Kind)).
		SetName(term.Name).
		SetSlug(term.Slug).
		SetDescription(term.Description).
		SetColor(term.Color).
		SetCreatedAt(term.CreatedAt).
		SetUpdatedAt(term.UpdatedAt).
		Save(ctx)
	if err != nil {
		return taxonomy.Term{}, storeError(err)
	}
	return toTerm(row), nil
}

// Update persists the mutable fields of a term.
func (s *Store) Update(ctx context.Context, term taxonomy.Term) (taxonomy.Term, error) {
	affected, err := s.client.TaxonomyTerm.Update().
		Where(taxonomyterm.IDEQ(term.ID), taxonomyterm.SiteIDEQ(term.SiteID)).
		SetName(term.Name).
		SetSlug(term.Slug).
		SetDescription(term.Description).
		SetColor(term.Color).
		SetUpdatedAt(term.UpdatedAt).
		Save(ctx)
	if err != nil {
		return taxonomy.Term{}, storeError(err)
	}
	if affected == 0 {
		return taxonomy.Term{}, taxonomy.ErrNotFound
	}

	row, err := s.client.TaxonomyTerm.Get(ctx, term.ID)
	if err != nil {
		return taxonomy.Term{}, err
	}
	return toTerm(row), nil
}

// Delete removes a term.
//
// Deleting a category clears the reference on the site's content instead of deleting
// it, which is what the product rule asks for ("a deleted category leaves the articles
// alone"). Tags are stored as names inside the content row, so they are intentionally
// left as plain text.
func (s *Store) Delete(ctx context.Context, siteID, termID string) error {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	row, err := tx.TaxonomyTerm.Query().
		Where(taxonomyterm.IDEQ(termID), taxonomyterm.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return taxonomy.ErrNotFound
		}
		return err
	}

	if row.Kind == string(taxonomy.KindCategory) {
		if _, err := tx.ContentItem.Update().
			Where(contentitem.SiteIDEQ(siteID), contentitem.CategoryIDEQ(termID)).
			ClearCategoryID().
			Save(ctx); err != nil {
			return err
		}
	}

	affected, err := tx.TaxonomyTerm.Delete().
		Where(taxonomyterm.IDEQ(termID), taxonomyterm.SiteIDEQ(siteID)).
		Exec(ctx)
	if err != nil {
		return err
	}
	if affected == 0 {
		return taxonomy.ErrNotFound
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// storeError translates a unique constraint violation into the domain conflict.
func storeError(err error) error {
	if entgen.IsConstraintError(err) {
		return taxonomy.ErrConflict
	}
	return err
}

func toTerm(row *entgen.TaxonomyTerm) taxonomy.Term {
	return taxonomy.Term{
		ID:          row.ID,
		SiteID:      row.SiteID,
		Kind:        taxonomy.Kind(row.Kind),
		Name:        row.Name,
		Slug:        row.Slug,
		Description: row.Description,
		Color:       row.Color,
		CreatedAt:   row.CreatedAt,
		UpdatedAt:   row.UpdatedAt,
	}
}
