package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// MediaUpload is an open two phase upload session.
type MediaUpload struct{ ent.Schema }

// Fields of MediaUpload.
func (MediaUpload) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("owner_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("file_name").MaxLen(200).NotEmpty(),
		field.String("declared_mime").MaxLen(120).NotEmpty(),
		field.Int64("size").NonNegative(),
		field.String("purpose").MaxLen(20).Validate(oneOf("content", "avatar", "attachment")),
		// The storage key is generated server side; the declared name never reaches it.
		field.String("storage_key").MaxLen(200).NotEmpty(),
		field.String("status").
			Default("pending").
			Validate(oneOf("pending", "uploaded", "completed", "expired")),
		field.Time("expires_at"),
		createdField(),
		updatedField(),
	}
}

// Indexes of MediaUpload.
func (MediaUpload) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("site_id", "owner_id"),
		index.Fields("expires_at"),
		index.Fields("storage_key"),
	}
}
