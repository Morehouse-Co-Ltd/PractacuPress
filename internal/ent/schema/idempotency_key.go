package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// IdempotencyKey stores the response of a completed write so a client retry with
// the same Idempotency-Key returns that response instead of repeating the effect
// (design §7.2, review P0-4).
type IdempotencyKey struct{ ent.Schema }

// Fields of IdempotencyKey.
func (IdempotencyKey) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("user_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("route").MaxLen(200).NotEmpty().Immutable(),
		field.String("key_value").MaxLen(128).NotEmpty().Immutable(),
		// request_hash detects the same key being reused for a different payload,
		// which is a client bug that must fail loudly instead of silently replaying.
		field.String("request_hash").MaxLen(64).NotEmpty(),
		field.Int("status_code"),
		field.Text("response_body").Optional(),
		field.Time("expires_at"),
		field.Time("created_at").Immutable().Default(nowUTC),
	}
}

// Indexes of IdempotencyKey.
func (IdempotencyKey) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "route", "key_value").Unique(),
		index.Fields("expires_at"),
	}
}
