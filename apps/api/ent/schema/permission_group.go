package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// PermissionGroup is one site's capability group.
//
// The four built-in groups are the expression layer over the fixed roles: their
// key never changes, so renaming one only changes the label an administrator sees.
// A custom group pins a base server role and a subset of that role's capabilities,
// which is what lets an operator hand out a narrower or differently named role
// without inventing a new server role.
type PermissionGroup struct{ ent.Schema }

// Fields of PermissionGroup.
func (PermissionGroup) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		// Key is the stable identifier used by memberships and the API. It is
		// immutable: renaming a group must never move its members.
		field.String("key").MaxLen(40).NotEmpty().Immutable(),
		// Name is the operator visible label. Empty means "use the built-in
		// localized name", so an installation that never renamed a group keeps
		// following the interface language.
		field.String("name").MaxLen(60).Default(""),
		field.String("base_role").
			Default(RoleMember).
			Validate(oneOf(RolePlatformAdmin, RoleSiteAdmin, RoleEditor, RoleMember)),
		// Capabilities is the enabled capability ids. Stored as a list so the table
		// stays dialect neutral; the service expands it into the full matrix.
		field.JSON("capabilities", []string{}).Optional(),
		field.Bool("admin_access").Default(false),
		// Builtin marks the four groups the server maps roles to. They can be
		// renamed and tuned, but not deleted or re-pointed at another role.
		field.Bool("builtin").Default(false),
		createdField(),
		updatedField(),
	}
}

// Indexes of PermissionGroup.
func (PermissionGroup) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("site_id", "key").Unique(),
		index.Fields("site_id"),
	}
}
