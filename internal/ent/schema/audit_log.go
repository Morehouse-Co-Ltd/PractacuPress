package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AuditLog records every privileged or security relevant action (design §8.2).
//
// site_id is optional because platform administrators act outside any single
// site; actor_id is optional because scheduled workers act without a user.
type AuditLog struct{ ent.Schema }

// Fields of AuditLog.
func (AuditLog) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("site_id").MaxLen(36).Optional().Nillable().Immutable(),
		field.String("actor_id").MaxLen(36).Optional().Nillable().Immutable(),
		field.String("action").MaxLen(120).NotEmpty().Immutable(),
		field.String("target_type").MaxLen(40).Optional().Nillable().Immutable(),
		field.String("target_id").MaxLen(36).Optional().Nillable().Immutable(),
		field.String("request_id").MaxLen(64).Optional().Nillable().Immutable(),
		field.String("outcome").MaxLen(20).Default("success").Immutable(),
		field.JSON("detail", map[string]any{}).Optional(),
		field.Time("created_at").Immutable().Default(nowUTC),
	}
}

// Indexes of AuditLog.
func (AuditLog) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("site_id", "created_at"),
		index.Fields("actor_id", "created_at"),
		index.Fields("target_type", "target_id"),
		// The admin activity page filters by action inside a site and a time range;
		// without this index that query degrades to a full scan of the audit table.
		index.Fields("action", "created_at"),
	}
}
