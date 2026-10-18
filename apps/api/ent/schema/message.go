package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Message is one message inside a conversation.
type Message struct{ ent.Schema }

// Fields of Message.
func (Message) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("conversation_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("sender_id").MaxLen(36).NotEmpty().Immutable(),
		field.Text("body"),
		createdField(),
	}
}

// Indexes of Message.
func (Message) Indexes() []ent.Index {
	return []ent.Index{
		// Reading a thread in order.
		index.Fields("conversation_id", "created_at"),
		index.Fields("site_id", "conversation_id"),
	}
}