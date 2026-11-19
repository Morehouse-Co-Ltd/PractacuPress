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
		// risk_score is computed on the server when the comment is written, from the
		// same signals the moderator sees (length, link density, repetition). It used
		// to be calculated in the browser, which meant the score depended on which
		// device opened the queue and disappeared entirely with JavaScript disabled.
		field.Int("risk_score").Default(0).NonNegative(),
		// risk_flags is a JSON array of the reasons behind the score, so a moderator
		// can see why a comment was ranked instead of trusting a bare number.
		field.Text("risk_flags").Default("[]"),
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
