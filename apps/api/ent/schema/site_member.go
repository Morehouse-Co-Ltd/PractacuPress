package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// The four fixed roles (design §3). They are ordered by authority; permission
// checks compare against this order rather than against ad hoc booleans.
const (
	RolePlatformAdmin = "platform_admin"
	RoleSiteAdmin     = "site_admin"
	RoleEditor        = "editor"
	RoleMember        = "member"
)

// Site member status values.
const (
	MemberStatusActive    = "active"
	MemberStatusInvited   = "invited"
	MemberStatusSuspended = "suspended"
)

// SiteMember is a user's relationship to one site.
//
// The role lives here, not on User, so the same account can be an editor on one
// site and an ordinary member on another.
type SiteMember struct{ ent.Schema }

// Fields of SiteMember.
func (SiteMember) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("user_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("role").
			Default(RoleMember).
			Validate(oneOf(RolePlatformAdmin, RoleSiteAdmin, RoleEditor, RoleMember)),
		field.String("status").
			Default(MemberStatusActive).
			Validate(oneOf(MemberStatusActive, MemberStatusInvited, MemberStatusSuspended)),
		// GroupKey is the capability group the member belongs to. Empty means
		// "derive the group from the role", which is how every existing row keeps
		// working after the permission groups migration.
		field.String("group_key").MaxLen(40).Default(""),
		field.Int64("media_quota_bytes").Optional().Nillable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of SiteMember.
func (SiteMember) Indexes() []ent.Index {
	return []ent.Index{
		// A user has exactly one membership per site, which makes role changes an
		// update and repeated joins idempotent.
		index.Fields("site_id", "user_id").Unique(),
		index.Fields("user_id"),
		index.Fields("site_id", "role"),
	}
}
