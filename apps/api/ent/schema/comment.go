package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Comment is one comment or reply.
//
// The target and parent are plain columns rather than foreign keys: comments point at
// articles, posts or other comments, which no single foreign key can express.
type Comment struct{ ent.Schema }

// Fields of Comment.
func (Comment) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("author_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("target_type").MaxLen(20).NotEmpty().Immutable(),
		field.String("target_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("parent_id").MaxLen(36).Optional().Nillable().Immutable(),
		field.Int("depth").Default(0).NonNegative().Immutable(),
		field.Text("body"),
		field.String("status").
			Default("visible").
			Validate(oneOf("visible", "hidden", "deleted", "pending_review")),
		createdField(),
		updatedField(),
	}
}

// Indexes of Comment.
func (Comment) Indexes() []ent.Index {
	return []ent.Index{
		// Reading a thread: all comments of one target, oldest first.
		index.Fields("site_id", "target_type", "target_id", "created_at"),
		index.Fields("site_id", "status"),
		index.Fields("parent_id"),
	}
}
