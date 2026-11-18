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
		// The purpose is persisted because storage may be configured per purpose: a
		// download or delete must use the same adapter the bytes were written to, and
		// only the record knows which adapter that was. It is nullable on purpose:
		// rows written before per purpose storage existed have no value and must fall
		// back to the global adapter, not to whichever scope now owns "content".
		field.String("purpose").
			MaxLen(20).
			Optional().
			Nillable().
			Validate(oneOf("content", "site", "avatar", "attachment")),
		// Only "clean" may be referenced from content. The default is deliberately the
		// most restrictive state, so a bug that forgets to set it cannot publish a file.
		field.String("scan_status").
			Default("pending").
			Validate(oneOf("pending", "clean", "rejected", "needs_manual_review")),
		field.String("scan_reason").MaxLen(120).Optional().Nillable(),
		// file_name is the name the uploader used, captured when the upload session
		// was opened. The library used to render a storage key fragment because the
		// column did not exist; the storage key itself stays server derived and is
		// never taken from user input.
		field.String("file_name").MaxLen(200).Default(""),
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
