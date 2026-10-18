package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Bookmark is a saved target for one user.
type Bookmark struct{ ent.Schema }

// Fields of Bookmark.
func (Bookmark) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("user_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("target_type").MaxLen(20).NotEmpty().Immutable(),
		field.String("target_id").MaxLen(36).NotEmpty().Immutable(),
		createdField(),
	}
}

// Indexes of Bookmark.
func (Bookmark) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "target_type", "target_id").Unique(),
		index.Fields("site_id", "user_id"),
	}
}
