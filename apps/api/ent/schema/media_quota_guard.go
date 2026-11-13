package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// MediaQuotaGuard provides a database row that serializes upload reservations per site.
type MediaQuotaGuard struct{ ent.Schema }

// Fields of MediaQuotaGuard.
func (MediaQuotaGuard) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("site_id").MaxLen(36).NotEmpty().Immutable(),
		field.Int64("serial").NonNegative().Default(0),
	}
}

// Indexes of MediaQuotaGuard.
func (MediaQuotaGuard) Indexes() []ent.Index {
	return []ent.Index{index.Fields("site_id").Unique()}
}
