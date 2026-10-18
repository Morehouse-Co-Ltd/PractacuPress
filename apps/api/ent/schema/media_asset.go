package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// MediaAsset is a stored object that has been through security inspection.
type MediaAsset struct{ ent.Schema }

// Fields of MediaAsset.
func (MediaAsset) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("owner_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("storage_key").MaxLen(200).NotEmpty().Immutable(),
		field.String("mime_type").MaxLen(120).NotEmpty(),
		field.Int64("size").NonNegative(),
		// Only "clean" may be referenced from content. The default is deliberately the
		// most restrictive state, so a bug that forgets to set it cannot publish a file.
		field.String("scan_status").
			Default("pending").
			Validate(oneOf("pending", "clean", "rejected", "needs_manual_review")),
		field.String("scan_reason").MaxLen(120).Optional().Nillable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of MediaAsset.
func (MediaAsset) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("storage_key").Unique(),
		index.Fields("site_id", "owner_id"),
		index.Fields("site_id", "scan_status"),
	}
}
