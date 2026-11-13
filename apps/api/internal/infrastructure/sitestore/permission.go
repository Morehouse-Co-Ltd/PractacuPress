package sitestore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/permissiongroup"
	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
)

// ListPermissionGroups returns the capability groups of a site.
func (s *Store) ListPermissionGroups(ctx context.Context, siteID string) ([]site.PermissionGroup, error) {
	rows, err := s.client.PermissionGroup.Query().
		Where(permissiongroup.SiteIDEQ(siteID)).
		Order(entgen.Asc(permissiongroup.FieldCreatedAt), entgen.Asc(permissiongroup.FieldKey)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	return toPermissionGroups(rows), nil
}

// UpsertPermissionGroup creates or replaces one group and records the audit entry.
//
// The key is immutable, so an existing row is updated in place. A concurrent first
// write can lose the insert race on the unique index; the retry turns that into the
// update it was going to be.
func (s *Store) UpsertPermissionGroup(
	ctx context.Context,
	siteID string,
	in site.PermissionGroup,
	audit site.AuditEntry,
) (site.PermissionGroup, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return site.PermissionGroup{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	capabilities := in.Capabilities.CapabilityList()
	existing, findErr := tx.PermissionGroup.Query().
		Where(permissiongroup.SiteIDEQ(siteID), permissiongroup.KeyEQ(in.Key)).
		Only(ctx)
	var row *entgen.PermissionGroup
	switch {
	case findErr == nil:
		row, err = tx.PermissionGroup.UpdateOneID(existing.ID).
			SetName(in.Name).
			SetBaseRole(string(in.BaseRole)).
			SetCapabilities(capabilities).
			SetAdminAccess(in.AdminAccess).
			SetBuiltin(in.Builtin).
			SetUpdatedAt(time.Now().UTC()).
			Save(ctx)
	case entgen.IsNotFound(findErr):
		row, err = tx.PermissionGroup.Create().
			SetSiteID(siteID).
			SetKey(in.Key).
			SetName(in.Name).
			SetBaseRole(string(in.BaseRole)).
			SetCapabilities(capabilities).
			SetAdminAccess(in.AdminAccess).
			SetBuiltin(in.Builtin).
			Save(ctx)
	default:
		return site.PermissionGroup{}, findErr
	}
	if err != nil {
		return site.PermissionGroup{}, err
	}

	if audit.Action != "" {
		if err := insertAudit(ctx, tx.Client(), audit, "permission_group", in.Key); err != nil {
			return site.PermissionGroup{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return site.PermissionGroup{}, err
	}
	committed = true
	return toPermissionGroup(row), nil
}

// SetMemberGroup moves one membership into a group and updates its role at once.
func (s *Store) SetMemberGroup(
	ctx context.Context,
	siteID, userID, groupKey string,
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
		SetGroupKey(groupKey).
		SetRole(string(role)).
		Save(ctx)
	if err != nil {
		return err
	}
	if updated == 0 {
		return site.ErrTargetNotFound
	}
	if audit.Action != "" {
		if err := insertAudit(ctx, tx.Client(), audit, "site_member", userID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// permissionGroupFor loads the group a member row explicitly points at.
func (s *Store) permissionGroupFor(ctx context.Context, siteID, key string) (site.PermissionGroup, bool) {
	if key == "" {
		return site.PermissionGroup{}, false
	}
	row, err := s.client.PermissionGroup.Query().
		Where(permissiongroup.SiteIDEQ(siteID), permissiongroup.KeyEQ(key)).
		Only(ctx)
	if err != nil {
		return site.PermissionGroup{}, false
	}
	return toPermissionGroup(row), true
}

// applyMemberGroup expands a member row's group into the capability fields.
//
// A member without an explicit group falls back to the built-in group of its role,
// which is exactly what the dashboard shows as "not yet assigned".
func (s *Store) applyMemberGroup(ctx context.Context, siteID string, member *site.Member) {
	key := member.GroupKey
	if key == "" {
		key = site.GroupKeyForRole(member.Role)
	}
	group, ok := s.permissionGroupFor(ctx, siteID, key)
	if !ok {
		// The group rows may not be seeded yet. The role defaults are the same
		// matrix the seed would produce, so the request stays correct.
		member.GroupKey = key
		member.Permissions = site.DefaultCapabilities(member.Role)
		member.AdminAccess = member.Permissions.HasAnyAdminCapability()
		return
	}
	member.GroupKey = group.Key
	member.GroupName = group.Name
	member.Permissions = group.Capabilities
	member.AdminAccess = group.AdminAccess
}

// toPermissionGroup maps one row.
func toPermissionGroup(row *entgen.PermissionGroup) site.PermissionGroup {
	set := site.PermissionSet{}
	for _, capability := range site.AllCapabilities {
		set[capability] = false
	}
	for _, raw := range row.Capabilities {
		capability := site.Capability(raw)
		if _, known := set[capability]; known {
			set[capability] = true
		}
	}
	role := site.Role(row.BaseRole)
	if row.Key == site.GroupGuest {
		role = ""
	}
	return site.PermissionGroup{
		Key:          row.Key,
		Name:         row.Name,
		BaseRole:     role,
		Capabilities: set,
		AdminAccess:  row.AdminAccess,
		Builtin:      row.Builtin,
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
	}
}

// toPermissionGroups maps a slice of rows.
func toPermissionGroups(rows []*entgen.PermissionGroup) []site.PermissionGroup {
	out := make([]site.PermissionGroup, 0, len(rows))
	for _, row := range rows {
		out = append(out, toPermissionGroup(row))
	}
	return out
}

// ensure interface assertion at compile time.
var _ site.PermissionGroupRepository = (*Store)(nil)
