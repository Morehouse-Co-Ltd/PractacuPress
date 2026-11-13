package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Conversation is one private thread.
type Conversation struct{ ent.Schema }

// Fields of Conversation.
func (Conversation) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("kind").MaxLen(20).Default("direct").Validate(oneOf("direct", "group")),
		field.String("created_by").MaxLen(36).NotEmpty().Immutable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of Conversation.
func (Conversation) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("site_id", "kind"),
	}
}
