package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Reaction is one user's reaction to one target.
//
// The unique index is what makes a retried like harmless: the second insert fails
// instead of creating a duplicate row that would double the count.
type Reaction struct{ ent.Schema }

// Fields of Reaction.
func (Reaction) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("user_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("target_type").MaxLen(20).NotEmpty().Immutable(),
		field.String("target_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("kind").MaxLen(20).NotEmpty().Immutable(),
		createdField(),
	}
}

// Indexes of Reaction.
func (Reaction) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "target_type", "target_id", "kind").Unique(),
		index.Fields("site_id", "target_type", "target_id"),
	}
}
