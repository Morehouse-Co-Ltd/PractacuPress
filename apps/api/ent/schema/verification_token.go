package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Verification token kinds.
const (
	VerificationEmailVerify   = "email_verify"
	VerificationPhoneVerify   = "phone_verify"
	VerificationPasswordReset = "password_reset"
)

// VerificationToken authorises a one-off email, phone or password action.
//
// Only the hash is stored, and consumed_at makes redemption single use.
type VerificationToken struct{ ent.Schema }

// Fields of VerificationToken.
func (VerificationToken) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("user_id").MaxLen(36).NotEmpty(),
		field.String("kind").
			Validate(oneOf(VerificationEmailVerify, VerificationPhoneVerify, VerificationPasswordReset)),
		field.String("token_hash").MaxLen(64).NotEmpty(),
		field.Time("expires_at"),
		field.Time("consumed_at").Optional().Nillable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of VerificationToken.
func (VerificationToken) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("token_hash").Unique(),
		index.Fields("user_id", "kind"),
		index.Fields("expires_at"),
	}
}
