package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ConversationMember is one participant and their read cursor.
type ConversationMember struct{ ent.Schema }

// Fields of ConversationMember.
func (ConversationMember) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("conversation_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("user_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("last_read_message_id").MaxLen(36).Optional().Nillable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of ConversationMember.
func (ConversationMember) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("conversation_id", "user_id").Unique(),
		index.Fields("user_id"),
	}
}
