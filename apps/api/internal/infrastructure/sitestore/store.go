// Package sitestore implements the site persistence port with Ent.
package sitestore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	entsite "github.com/practacu/practacu-press/apps/api/ent/site"
	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
	"github.com/practacu/practacu-press/apps/api/ent/user"
)

// Store is the Ent backed implementation of site.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ site.Repository = (*Store)(nil)

// FindByDomain returns the site whose domain matches hostname.
func (s *Store) FindByDomain(ctx context.Context, hostname string) (site.Site, error) {
	row, err := s.client.Site.Query().Where(entsite.DomainEQ(hostname)).Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return site.Site{}, site.ErrNotFound
		}
		return site.Site{}, err
	}
	return toSite(row), nil
}

// FindByID returns a site by id.
func (s *Store) FindByID(ctx context.Context, siteID string) (site.Site, error) {
	row, err := s.client.Site.Get(ctx, siteID)
	if err != nil {
		if entgen.IsNotFound(err) {
			return site.Site{}, site.ErrNotFound
		}
		return site.Site{}, err
	}
	return toSite(row), nil
}

// SingleSite returns the only site when exactly one exists.
func (s *Store) SingleSite(ctx context.Context) (site.Site, bool, error) {
	count, err := s.client.Site.Query().Count(ctx)
	if err != nil {
		return site.Site{}, false, err
	}
	if count != 1 {
		return site.Site{}, false, nil
	}

	row, err := s.client.Site.Query().First(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return site.Site{}, false, nil
		}
		return site.Site{}, false, err
	}
	return toSite(row), true, nil
}

// FindMember returns a membership on a site.
func (s *Store) FindMember(ctx context.Context, siteID, userID string) (site.Member, error) {
	row, err := s.client.SiteMember.Query().
		Where(sitemember.SiteIDEQ(siteID), sitemember.UserIDEQ(userID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return site.Member{}, site.ErrMemberNotFound
		}
		return site.Member{}, err
	}

	member := toMember(row)
	if account, err := s.client.User.Get(ctx, row.UserID); err == nil {
		member.DisplayName = account.DisplayName
	}
	return member, nil
}

// ListMembers returns members ordered by creation time.
func (s *Store) ListMembers(ctx context.Context, siteID string, limit int) ([]site.Member, error) {
	rows, err := s.client.SiteMember.Query().
		Where(sitemember.SiteIDEQ(siteID)).
		Order(entgen.Asc(sitemember.FieldCreatedAt)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}

	userIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		userIDs = append(userIDs, row.UserID)
	}

	accounts, err := s.client.User.Query().Where(user.IDIn(userIDs...)).All(ctx)
	if err != nil {
		return nil, err
	}
	names := make(map[string]string, len(accounts))
	for _, account := range accounts {
		names[account.ID] = account.DisplayName
	}

	members := make([]site.Member, 0, len(rows))
	for _, row := range rows {
		member := toMember(row)
		member.DisplayName = names[row.UserID]
		members = append(members, member)
	}
	return members, nil
}

// UpdateMemberRole changes a role and records the audit entry in one transaction.
func (s *Store) UpdateMemberRole(
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

	updated, err := tx.SiteMember.Update().
		Where(sitemember.SiteIDEQ(siteID), sitemember.UserIDEQ(userID)).
		SetRole(string(role)).
		Save(ctx)
	if err != nil {
		return err
	}
	if updated == 0 {
		return site.ErrMemberNotFound
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

// UpdateSettings changes site settings and records the audit entry in one
// transaction. Empty values are left untouched, which makes the endpoint a partial
// update rather than a replace.
func (s *Store) UpdateSettings(
	ctx context.Context,
	siteID string,
	in site.SettingsInput,
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

	update := tx.Site.UpdateOneID(siteID)
	if in.Name != "" {
		update.SetName(in.Name)
	}
	if in.Description != "" {
		update.SetDescription(in.Description)
	}
	if in.VisibilityMode != "" {
		update.SetVisibilityMode(string(in.VisibilityMode))
	}
	if in.PublishMode != "" {
		update.SetPublishMode(string(in.PublishMode))
	}
	if in.Domain != "" {
		update.SetDomain(in.Domain)
	}

	if _, err := update.Save(ctx); err != nil {
		if entgen.IsNotFound(err) {
			return site.ErrNotFound
		}
		return err
	}

	if err := insertAudit(ctx, tx.Client(), audit, "site", siteID); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

func insertAudit(ctx context.Context, client *entgen.Client, entry site.AuditEntry, targetType, targetID string) error {
	at := entry.At
	if at.IsZero() {
		at = time.Now().UTC()
	}

	builder := client.AuditLog.Create().
		SetAction(entry.Action).
		SetTargetType(targetType).
		SetTargetID(targetID).
		SetCreatedAt(at)

	if entry.SiteID != "" {
		builder.SetSiteID(entry.SiteID)
	}
	if entry.ActorID != "" {
		builder.SetActorID(entry.ActorID)
	}
	if entry.RequestID != "" {
		builder.SetRequestID(entry.RequestID)
	}
	if entry.Detail != nil {
		builder.SetDetail(entry.Detail)
	}

	_, err := builder.Save(ctx)
	return err
}

func toSite(row *entgen.Site) site.Site {
	result := site.Site{
		ID:             row.ID,
		Slug:           row.Slug,
		Name:           row.Name,
		VisibilityMode: site.VisibilityMode(row.VisibilityMode),
		PublishMode:    site.PublishMode(row.PublishMode),
		Disabled:       row.Disabled,
		CreatedAt:      row.CreatedAt,
		UpdatedAt:      row.UpdatedAt,
	}
	if row.Domain != nil {
		result.Domain = *row.Domain
	}
	if row.Description != nil {
		result.Description = *row.Description
	}
	result.DomainVerifiedAt = row.DomainVerifiedAt
	return result
}

func toMember(row *entgen.SiteMember) site.Member {
	return site.Member{
		ID:        row.ID,
		SiteID:    row.SiteID,
		UserID:    row.UserID,
		Role:      site.Role(row.Role),
		Status:    row.Status,
		CreatedAt: row.CreatedAt,
	}
}

