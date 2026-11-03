// Package sitestore implements the site persistence port with Ent.
package sitestore

import (
	"context"
	"fmt"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/session"
	entsite "github.com/practacu/practacu-press/apps/api/ent/site"
	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
	"github.com/practacu/practacu-press/apps/api/ent/user"
	"github.com/practacu/practacu-press/apps/api/ent/useridentity"
)

// providerEmail is the identity provider used by email and password accounts. It
// mirrors authstore.ProviderEmail; both adapters read the same table.
const providerEmail = "email"

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
	if identity, err := s.client.UserIdentity.Query().
		Where(useridentity.UserIDEQ(row.UserID), useridentity.ProviderEQ(providerEmail)).
		Only(ctx); err == nil {
		member.Email = identityEmail(identity)
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

	// The admin screen shows the login email next to each member, so one extra query
	// joins it in instead of a query per row.
	identities, err := s.client.UserIdentity.Query().
		Where(useridentity.UserIDIn(userIDs...), useridentity.ProviderEQ(providerEmail)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	emails := make(map[string]string, len(identities))
	for _, identity := range identities {
		emails[identity.UserID] = identityEmail(identity)
	}

	members := make([]site.Member, 0, len(rows))
	for _, row := range rows {
		member := toMember(row)
		member.DisplayName = names[row.UserID]
		member.Email = emails[row.UserID]
		members = append(members, member)
	}
	return members, nil
}

// identityEmail returns the address a login identity authenticates, falling back to
// the provider subject when the denormalised email column is empty.
func identityEmail(identity *entgen.UserIdentity) string {
	if identity.Email != nil && *identity.Email != "" {
		return *identity.Email
	}
	return identity.ProviderSubject
}

// CountAdmins returns how many active members may administer a site.
//
// A count is enough: callers only ask whether anyone is left, and the wizard must
// not learn who the administrators are before it has a session.
func (s *Store) CountAdmins(ctx context.Context, siteID string) (int, error) {
	return s.client.SiteMember.Query().
		Where(
			sitemember.SiteIDEQ(siteID),
			sitemember.StatusEQ(site.MemberStatusActive),
			sitemember.RoleIn(string(site.RolePlatformAdmin), string(site.RoleSiteAdmin)),
		).
		Count(ctx)
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

// CountMembersByRole returns how many active members of a site hold role.
//
// Only active memberships count: a suspended platform administrator cannot log in,
// so it must not keep a site recoverable-looking when nobody else can administer it.
func (s *Store) CountMembersByRole(ctx context.Context, siteID string, role site.Role) (int, error) {
	return s.client.SiteMember.Query().
		Where(
			sitemember.SiteIDEQ(siteID),
			sitemember.RoleEQ(string(role)),
			sitemember.StatusEQ(site.MemberStatusActive),
		).
		Count(ctx)
}

// UpdateMemberProfile changes the account behind a membership.
//
// The display name lives on User, while the login address is the email identity:
// both writes are in one transaction with the audit entry, so an email change can
// never be recorded without also changing the identity that actually logs in.
func (s *Store) UpdateMemberProfile(
	ctx context.Context,
	siteID, userID string,
	in site.MemberProfile,
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

	if in.DisplayName != nil {
		if err := tx.User.UpdateOneID(userID).SetDisplayName(*in.DisplayName).Exec(ctx); err != nil {
			if entgen.IsNotFound(err) {
				return site.ErrTargetNotFound
			}
			return err
		}
	}

	if in.Email != nil {
		identity, err := tx.UserIdentity.Query().
			Where(useridentity.UserIDEQ(userID), useridentity.ProviderEQ(providerEmail)).
			Only(ctx)
		if err != nil {
			if entgen.IsNotFound(err) {
				return fmt.Errorf("%w: account has no email identity", site.ErrInvalidInput)
			}
			return err
		}

		// Email is unique across the install: check before writing so the caller gets
		// a 409 instead of a database constraint error.
		taken, err := tx.UserIdentity.Query().
			Where(
				useridentity.ProviderEQ(providerEmail),
				useridentity.ProviderSubjectEQ(*in.Email),
				useridentity.UserIDNEQ(userID),
			).
			Exist(ctx)
		if err != nil {
			return err
		}
		if taken {
			return site.ErrEmailTaken
		}

		if _, err := tx.UserIdentity.UpdateOneID(identity.ID).
			SetProviderSubject(*in.Email).
			SetEmail(*in.Email).
			Save(ctx); err != nil {
			return err
		}
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

// UpdateMemberStatus changes the membership status and records the audit entry.
func (s *Store) UpdateMemberStatus(
	ctx context.Context,
	siteID, userID, status string,
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
		SetStatus(status).
		Save(ctx)
	if err != nil {
		return err
	}
	if updated == 0 {
		return site.ErrTargetNotFound
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

// DeleteMember removes the membership and revokes the member's sessions on this site.
//
// The account row is intentionally kept: content, comments and other site
// memberships reference it, and the product promise is "removed from this site",
// not "account erased". Revoking the site's sessions means a live access token stops
// being refreshable immediately, which is the part of removal the user can observe.
func (s *Store) DeleteMember(
	ctx context.Context,
	siteID, userID string,
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

	deleted, err := tx.SiteMember.Delete().
		Where(sitemember.SiteIDEQ(siteID), sitemember.UserIDEQ(userID)).
		Exec(ctx)
	if err != nil {
		return err
	}
	if deleted == 0 {
		return site.ErrTargetNotFound
	}

	at := audit.At
	if at.IsZero() {
		at = time.Now().UTC()
	}
	if _, err := tx.Session.Update().
		Where(
			session.UserIDEQ(userID),
			session.SiteIDEQ(siteID),
			session.RevokedAtIsNil(),
		).
		SetRevokedAt(at).
		SetRevokedReason("member_removed").
		Save(ctx); err != nil {
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
	if in.RegistrationOpen != nil {
		// nil means "leave untouched"; the explicit value is stored as given so a
		// reopened registration can never be flipped back by a default.
		update.SetRegistrationOpen(*in.RegistrationOpen)
	}
	if in.Domain != "" {
		update.SetDomain(in.Domain)
		// A domain written through settings is a fresh challenge: store the token and
		// drop any previous verification, so the hostname only starts serving after
		// the DNS proof succeeds.
		if in.DomainToken != "" {
			update.SetDomainVerificationToken(in.DomainToken)
		} else {
			update.ClearDomainVerificationToken()
		}
		update.ClearDomainVerifiedAt()
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

// UpdateDomain sets or clears the primary domain, its challenge token and its
// verification timestamp.
//
// Clearing writes SQL NULL for all three columns, which is what makes the single-site
// domain-less fallback active again. A non-empty domain stores the token and only
// keeps domain_verified_at when VerifiedAt is supplied (the DNS challenge succeeded).
// The audit entry is committed with the change.
func (s *Store) UpdateDomain(
	ctx context.Context,
	siteID string,
	in site.DomainInput,
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
	if in.Domain == "" {
		update.ClearDomain().ClearDomainVerificationToken().ClearDomainVerifiedAt()
	} else {
		update.SetDomain(in.Domain)
		if in.Token != "" {
			update.SetDomainVerificationToken(in.Token)
		} else {
			update.ClearDomainVerificationToken()
		}
		if in.VerifiedAt != nil {
			update.SetDomainVerifiedAt(*in.VerifiedAt)
		} else {
			update.ClearDomainVerifiedAt()
		}
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
		ID:               row.ID,
		Slug:             row.Slug,
		Name:             row.Name,
		VisibilityMode:   site.VisibilityMode(row.VisibilityMode),
		PublishMode:      site.PublishMode(row.PublishMode),
		RegistrationOpen: row.RegistrationOpen,
		Disabled:         row.Disabled,
		CreatedAt:        row.CreatedAt,
		UpdatedAt:        row.UpdatedAt,
	}
	if row.Domain != nil {
		result.Domain = *row.Domain
	}
	if row.DomainVerificationToken != nil {
		result.DomainVerificationToken = *row.DomainVerificationToken
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
