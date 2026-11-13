package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// User status values.
const (
	UserStatusActive   = "active"
	UserStatusDisabled = "disabled"
)

// User is a global account. Everything site specific lives in SiteMember, so an
// account can participate in several sites without duplication.
type User struct{ ent.Schema }

// Fields of User.
func (User) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("display_name").MaxLen(120).NotEmpty(),
		field.String("status").
			Default(UserStatusActive).
			Validate(oneOf(UserStatusActive, UserStatusDisabled)),
		field.String("bio").MaxLen(2000).Optional().Nillable(),
		field.String("avatar_media_id").MaxLen(36).Optional().Nillable(),
		// email_verified_at is the account level mirror of the email identity's
		// verified_at. The identity stays the source of truth for authentication; this
		// column lets profile responses report the state without a second query, and is
		// only ever written forward (NULL -> timestamp), never cleared by a password
		// reset or an email change.
		field.Time("email_verified_at").Optional().Nillable(),
		field.String("locale").MaxLen(20).Default("zh-CN"),
		createdField(),
		updatedField(),
	}
}

// Indexes of User.
func (User) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("status"),
	}
}
