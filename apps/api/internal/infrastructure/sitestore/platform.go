// The platform console adapter lives here, next to the site module's own store: it
// creates a site together with its initial design document, and it grants a cross-site
// operator a live membership on the target site. The site module's own port stays in
// store.go.
package sitestore

import (
	"context"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	entsite "github.com/practacu/practacu-press/apps/api/ent/site"
	"github.com/practacu/practacu-press/apps/api/ent/sitecustomization"
	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
	"github.com/practacu/practacu-press/apps/api/internal/platformadmin"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

var _ platformadmin.Repository = (*Store)(nil)

// CreateSite inserts the site and its default design document in one transaction.
//
// The design row is created here, not lazily on the first save, so a site created from
// the console is a complete tenant: its public pages render the default design and the
// page builder opens on a real revision instead of creating one on first save.
func (s *Store) CreateSite(ctx context.Context, in platformadmin.SiteRecord) (site.Site, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return site.Site{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	create := tx.Site.Create().
		SetName(in.Name).
		SetSlug(in.Slug).
		SetVisibilityMode(string(in.VisibilityMode)).
		SetPublishMode(string(in.PublishMode)).
		SetRegistrationOpen(in.RegistrationOpen).
		SetCommentsEnabled(in.CommentsEnabled).
		SetCommentsRequireReview(in.CommentsRequireReview)
	if in.Description != "" {
		create.SetDescription(in.Description)
	}
	if in.Domain != "" {
		create.SetDomain(in.Domain)
	}
	if in.DomainToken != "" {
		create.SetDomainVerificationToken(in.DomainToken)
	}

	row, err := create.Save(ctx)
	if err != nil {
		return site.Site{}, err
	}

	document := in.DesignDocument
	if len(document) == 0 {
		document = []byte(platformadmin.DefaultDesignDocument)
	}
	if _, err := tx.SiteCustomization.Create().
		SetSiteID(row.ID).
		SetDocument(string(document)).
		SetRevision(1).
		Save(ctx); err != nil {
		return site.Site{}, err
	}

	if err := tx.Commit(); err != nil {
		return site.Site{}, err
	}
	committed = true
	return toSite(row), nil
}

// DeleteSite removes a site and the rows that were created with it.
//
// It is only used as compensation: when provisioning the first administrator fails, the
// half created site must not remain visible in the console. Memberships and sessions are
// removed too so a retry starts from a clean slate on every database.
func (s *Store) DeleteSite(ctx context.Context, siteID string) error {
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

	if _, err := tx.SiteCustomization.Delete().
		Where(sitecustomization.SiteIDEQ(siteID)).
		Exec(ctx); err != nil {
		return err
	}
	if _, err := tx.SiteMember.Delete().
		Where(sitemember.SiteIDEQ(siteID)).
		Exec(ctx); err != nil {
		return err
	}
	if err := tx.Site.DeleteOneID(siteID).Exec(ctx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// FindSite loads one site by id.
func (s *Store) FindSite(ctx context.Context, siteID string) (site.Site, error) {
	row, err := s.client.Site.Get(ctx, siteID)
	if err != nil {
		if entgen.IsNotFound(err) {
			return site.Site{}, site.ErrNotFound
		}
		return site.Site{}, err
	}
	return toSite(row), nil
}

// ListSites returns sites ordered by creation time.
func (s *Store) ListSites(ctx context.Context, limit int) ([]site.Site, error) {
	if limit <= 0 {
		limit = platformadmin.MaxListedSites
	}
	rows, err := s.client.Site.Query().
		Order(entgen.Asc(entsite.FieldCreatedAt)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}
	sites := make([]site.Site, 0, len(rows))
	for _, row := range rows {
		sites = append(sites, toSite(row))
	}
	return sites, nil
}

// SlugTaken reports whether another site owns slug.
func (s *Store) SlugTaken(ctx context.Context, slug string) (bool, error) {
	return s.client.Site.Query().Where(entsite.SlugEQ(slug)).Exist(ctx)
}

// DomainTaken reports whether another site owns domain.
func (s *Store) DomainTaken(ctx context.Context, domain string) (bool, error) {
	return s.client.Site.Query().Where(entsite.DomainEQ(domain)).Exist(ctx)
}

// CountMembers returns how many memberships a site has, suspended ones included.
func (s *Store) CountMembers(ctx context.Context, siteID string) (int, error) {
	return s.client.SiteMember.Query().
		Where(sitemember.SiteIDEQ(siteID)).
		Count(ctx)
}

// EnsureMember makes userID an active member of siteID with role.
//
// The console uses it when a platform administrator enters a site they have never
// joined. The membership is the authority every site endpoint re-reads, so the handoff
// token alone would not be enough.
func (s *Store) EnsureMember(
	ctx context.Context,
	siteID, userID string,
	role site.Role,
	audit site.AuditEntry,
) error {
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

	existing, err := tx.SiteMember.Query().
		Where(sitemember.SiteIDEQ(siteID), sitemember.UserIDEQ(userID)).
		Only(ctx)
	switch {
	case err == nil:
		if _, err := tx.SiteMember.UpdateOneID(existing.ID).
			SetRole(string(role)).
			SetStatus(site.MemberStatusActive).
			Save(ctx); err != nil {
			return err
		}
	case entgen.IsNotFound(err):
		if _, err := tx.SiteMember.Create().
			SetSiteID(siteID).
			SetUserID(userID).
			SetRole(string(role)).
			SetStatus(site.MemberStatusActive).
			Save(ctx); err != nil {
			return err
		}
	default:
		return err
	}

	if err := insertAudit(ctx, tx.Client(), audit, "site_member", userID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// RecordAudit appends one audit entry.
func (s *Store) RecordAudit(ctx context.Context, audit site.AuditEntry) error {
	target := audit.Target
	if target == "" {
		target = audit.SiteID
	}
	return insertAudit(ctx, s.client, audit, "site", target)
}
