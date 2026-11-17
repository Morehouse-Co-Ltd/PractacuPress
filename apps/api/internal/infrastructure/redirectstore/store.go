// Package redirectstore implements the redirect persistence port with Ent.
package redirectstore

import (
	"context"
	"strings"
	"time"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	entredirect "github.com/practacu/practacu-press/apps/api/ent/redirect"

	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/redirect"
)

// Store is the Ent backed implementation of redirect.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ redirect.Repository = (*Store)(nil)

// List returns one page of a site's rules, newest first.
func (s *Store) List(
	ctx context.Context,
	siteID, query string,
	limit int,
	after page.Cursor,
) ([]redirect.Redirect, string, error) {
	builder := s.client.Redirect.Query().Where(entredirect.SiteIDEQ(siteID))

	if query = strings.TrimSpace(query); query != "" {
		// A fuzzy match over both sides of the rule is what the admin search box
		// documents: an operator looking for an old URL does not know which column it is.
		builder.Where(entredirect.Or(
			entredirect.FromPathContainsFold(query),
			entredirect.ToPathContainsFold(query),
		))
	}

	if !after.IsZero() {
		key, err := time.Parse(time.RFC3339Nano, after.Key)
		if err != nil {
			return nil, "", err
		}
		// The sort is (created_at DESC, id DESC); both halves are needed or rules
		// sharing a timestamp would be skipped at the page boundary.
		builder.Where(entredirect.Or(
			entredirect.CreatedAtLT(key),
			entredirect.And(
				entredirect.CreatedAtEQ(key),
				entredirect.IDLT(after.ID),
			),
		))
	}

	rows, err := builder.
		Order(entgen.Desc(entredirect.FieldCreatedAt), entgen.Desc(entredirect.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return nil, "", err
	}

	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = page.Cursor{
			Key: last.CreatedAt.UTC().Format(time.RFC3339Nano),
			ID:  last.ID,
		}.Encode()
	}

	rules := make([]redirect.Redirect, 0, len(rows))
	for _, row := range rows {
		rules = append(rules, toRedirect(row))
	}
	return rules, next, nil
}

// FindByPath loads the rule that owns an exact normalised path.
func (s *Store) FindByPath(ctx context.Context, siteID, fromPath string) (redirect.Redirect, error) {
	row, err := s.client.Redirect.Query().
		Where(entredirect.SiteIDEQ(siteID), entredirect.FromPathEQ(fromPath)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return redirect.Redirect{}, redirect.ErrNotFound
		}
		return redirect.Redirect{}, err
	}
	return toRedirect(row), nil
}

// FindByID loads one rule inside a site scope.
func (s *Store) FindByID(ctx context.Context, siteID, redirectID string) (redirect.Redirect, error) {
	row, err := s.client.Redirect.Query().
		Where(entredirect.IDEQ(redirectID), entredirect.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return redirect.Redirect{}, redirect.ErrNotFound
		}
		return redirect.Redirect{}, err
	}
	return toRedirect(row), nil
}

// Insert stores a new rule.
func (s *Store) Insert(ctx context.Context, rule redirect.Redirect) (redirect.Redirect, error) {
	row, err := s.client.Redirect.Create().
		SetSiteID(rule.SiteID).
		SetFromPath(rule.FromPath).
		SetToPath(rule.ToPath).
		SetStatusCode(rule.StatusCode).
		SetSource(string(rule.Source)).
		SetHitCount(rule.HitCount).
		SetCreatedAt(rule.CreatedAt).
		SetUpdatedAt(rule.UpdatedAt).
		Save(ctx)
	if err != nil {
		return redirect.Redirect{}, storeError(err)
	}
	return toRedirect(row), nil
}

// Update persists the mutable fields of a rule.
func (s *Store) Update(ctx context.Context, rule redirect.Redirect) (redirect.Redirect, error) {
	affected, err := s.client.Redirect.Update().
		Where(entredirect.IDEQ(rule.ID), entredirect.SiteIDEQ(rule.SiteID)).
		SetFromPath(rule.FromPath).
		SetToPath(rule.ToPath).
		SetStatusCode(rule.StatusCode).
		SetSource(string(rule.Source)).
		SetUpdatedAt(rule.UpdatedAt).
		Save(ctx)
	if err != nil {
		return redirect.Redirect{}, storeError(err)
	}
	if affected == 0 {
		return redirect.Redirect{}, redirect.ErrNotFound
	}

	row, err := s.client.Redirect.Get(ctx, rule.ID)
	if err != nil {
		return redirect.Redirect{}, err
	}
	return toRedirect(row), nil
}

// Delete removes a rule.
func (s *Store) Delete(ctx context.Context, siteID, redirectID string) error {
	affected, err := s.client.Redirect.Delete().
		Where(entredirect.IDEQ(redirectID), entredirect.SiteIDEQ(siteID)).
		Exec(ctx)
	if err != nil {
		return err
	}
	if affected == 0 {
		return redirect.ErrNotFound
	}
	return nil
}

// IncrementHitCount adds one to a rule's coarse popularity counter.
//
// The update is best effort at the call site: the service launches it detached and
// drops the error. Ent's UpdateDefault also stamps updated_at here, which the admin
// list shows as the last access time; hit counting is not an edit, but a separate
// column for it would cost more than the label is worth.
func (s *Store) IncrementHitCount(ctx context.Context, siteID, redirectID string) error {
	_, err := s.client.Redirect.Update().
		Where(entredirect.IDEQ(redirectID), entredirect.SiteIDEQ(siteID)).
		AddHitCount(1).
		Save(ctx)
	return err
}

// storeError translates a unique constraint violation into the domain conflict.
func storeError(err error) error {
	if entgen.IsConstraintError(err) {
		return redirect.ErrConflict
	}
	return err
}

func toRedirect(row *entgen.Redirect) redirect.Redirect {
	return redirect.Redirect{
		ID:         row.ID,
		SiteID:     row.SiteID,
		FromPath:   row.FromPath,
		ToPath:     row.ToPath,
		StatusCode: row.StatusCode,
		Source:     redirect.Source(row.Source),
		HitCount:   row.HitCount,
		CreatedAt:  row.CreatedAt,
		UpdatedAt:  row.UpdatedAt,
	}
}
