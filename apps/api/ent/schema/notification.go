package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Notification is one in-app message for exactly one user.
//
// There is no broadcast row: fan-out is written one row per recipient so read state and
// the listing query stay per user.
type Notification struct{ ent.Schema }

// Fields of Notification.
func (Notification) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("user_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("type").MaxLen(40).NotEmpty().Immutable(),
		field.String("actor_id").MaxLen(36).Optional().Nillable().Immutable(),
		field.String("subject_id").MaxLen(36).Optional().Nillable().Immutable(),
		field.JSON("payload", map[string]string{}).Optional(),
		field.Time("read_at").Optional().Nillable(),
		createdField(),
	}
}

// Indexes of Notification.
func (Notification) Indexes() []ent.Index {
	return []ent.Index{
		// The inbox query: one user's notifications, newest first.
		index.Fields("site_id", "user_id", "created_at"),
		// The unread badge.
		index.Fields("site_id", "user_id", "read_at"),
	}
}