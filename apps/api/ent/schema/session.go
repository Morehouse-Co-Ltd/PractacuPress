package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Session is one refresh token lineage.
//
// Only the hash of the opaque refresh token is stored. family_id links every
// rotation of one login, so replaying a rotated token can revoke the whole family
// (design §7.3 rule 2, review P0-1).
type Session struct{ ent.Schema }

// Fields of Session.
func (Session) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("user_id").MaxLen(36).NotEmpty(),
		field.String("token_hash").MaxLen(64).NotEmpty(),
		field.String("family_id").MaxLen(36).NotEmpty(),
		field.String("parent_id").MaxLen(36).Optional().Nillable(),
		field.String("user_agent").MaxLen(512).Optional().Nillable(),
		field.String("ip_address").MaxLen(64).Optional().Nillable(),
		field.Time("expires_at"),
		field.Time("rotated_at").Optional().Nillable(),
		field.Time("revoked_at").Optional().Nillable(),
		field.String("revoked_reason").MaxLen(64).Optional().Nillable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of Session.
func (Session) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("token_hash").Unique(),
		index.Fields("user_id"),
		index.Fields("family_id"),
		index.Fields("expires_at"),
	}
}
