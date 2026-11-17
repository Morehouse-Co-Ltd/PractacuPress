package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Phone login code purposes. A login and a registration code are not interchangeable:
// registration is only allowed when the site keeps self service sign-ups open, while
// login needs an existing account.
const (
	PhoneCodePurposeLogin    = "login"
	PhoneCodePurposeRegister = "register"
)

// PhoneCode is one short lived SMS verification code.
//
// The number itself is never stored in the clear: only a hash is written, because the
// row exists for five minutes and the address book of a site's members is exactly what
// a database leak should not hand over. phone_masked keeps enough of the number for
// the dashboard to show which code was requested without being a usable identifier.
//
// The row is an immutable event except for attempts and consumed_at: a wrong code
// increments attempts, and a successful redemption stamps consumed_at so the same
// code cannot be replayed.
type PhoneCode struct{ ent.Schema }

// Fields of PhoneCode.
func (PhoneCode) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		// phone_hash is the keyed hash of the E.164-ish digits the caller supplied.
		field.String("phone_hash").MaxLen(64).NotEmpty(),
		// phone_masked is display only, for example "138****8000".
		field.String("phone_masked").MaxLen(32).Default(""),
		field.String("purpose").
			Default(PhoneCodePurposeLogin).
			Validate(oneOf(PhoneCodePurposeLogin, PhoneCodePurposeRegister)),
		field.String("code_hash").MaxLen(64).NotEmpty(),
		field.Int("attempts").NonNegative().Default(0),
		// request_ip_hash bounds one source address to a handful of codes per hour
		// without storing the address itself.
		field.String("request_ip_hash").MaxLen(64).Default(""),
		field.Time("expires_at"),
		field.Time("consumed_at").Optional().Nillable(),
		createdField(),
	}
}

// Indexes of PhoneCode.
func (PhoneCode) Indexes() []ent.Index {
	return []ent.Index{
		// Redemption looks up the newest unconsumed code for one number and purpose.
		index.Fields("site_id", "phone_hash", "purpose", "created_at"),
		// The sweeper deletes expired rows.
		index.Fields("expires_at"),
		// Rate limiting counts recent requests from one address.
		index.Fields("site_id", "request_ip_hash", "created_at"),
	}
}
