package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// NotificationPreference stores one member's notification choices on one site.
//
// It is separate from the notification rows instead of a JSON blob on users: the
// choices are queried on every produced notification, so they need an indexed row,
// and keeping them per site means a member can mute likes on one site without
// muting them on every site of the same account.
//
// A missing row means the defaults: in-app notifications on for every type, email
// off. The service never has to materialise a row to read the defaults.
type NotificationPreference struct{ ent.Schema }

// Fields of NotificationPreference.
func (NotificationPreference) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("user_id").MaxLen(36).NotEmpty().Immutable(),
		// Channel master switches.
		field.Bool("in_app_enabled").Default(true),
		field.Bool("email_enabled").Default(false),
		// In-app categories. Moderation covers review decisions and the contact
		// form, both of which address site staff rather than ordinary readers.
		field.Bool("in_app_comments").Default(true),
		field.Bool("in_app_reactions").Default(true),
		field.Bool("in_app_follows").Default(true),
		field.Bool("in_app_moderation").Default(true),
		// Email categories share the same four buckets. They default on so enabling
		// the email master switch has an immediate, useful effect.
		field.Bool("email_comments").Default(true),
		field.Bool("email_reactions").Default(true),
		field.Bool("email_follows").Default(true),
		field.Bool("email_moderation").Default(true),
		createdField(),
		updatedField(),
	}
}

// Indexes of NotificationPreference.
func (NotificationPreference) Indexes() []ent.Index {
	return []ent.Index{
		// One preference row per member and site; the write path upserts on it.
		index.Fields("site_id", "user_id").Unique(),
	}
}
