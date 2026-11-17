package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Subscriber states. A subscription starts pending and only becomes confirmed after
// the address owner clicks the link in the confirmation mail: anyone could otherwise
// subscribe a stranger's address to a newsletter.
const (
	SubscriberStatusPending      = "pending"
	SubscriberStatusConfirmed    = "confirmed"
	SubscriberStatusUnsubscribed = "unsubscribed"
	SubscriberStatusBounced      = "bounced"
)

// Subscriber is one mailing list entry for one site.
//
// The email is stored lowercase so the unique index makes "Alice@Example.com" and
// "alice@example.com" the same subscription. token_hash follows the repository rule
// for one-off URLs: only the hash is written, and the plaintext token exists only
// inside the mailed link, so a database leak cannot be replayed as an unsubscribe or
// confirmation link.
type Subscriber struct{ ent.Schema }

// Fields of Subscriber.
func (Subscriber) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("email").MaxLen(320).NotEmpty(),
		field.String("status").
			Default(SubscriberStatusPending).
			Validate(oneOf(
				SubscriberStatusPending,
				SubscriberStatusConfirmed,
				SubscriberStatusUnsubscribed,
				SubscriberStatusBounced,
			)),
		field.String("token_hash").MaxLen(64).NotEmpty(),
		// source records where the subscription came from: the public footer form, a
		// logged in account opt-in, or an administrator import.
		field.String("source").MaxLen(40).Default("site"),
		// user_id links the subscription to an account when the subscriber was signed
		// in. Nullable because the public form needs no account at all.
		field.String("user_id").MaxLen(36).Optional().Nillable(),
		field.Time("confirmed_at").Optional().Nillable(),
		field.Time("unsubscribed_at").Optional().Nillable(),
		field.Time("last_sent_at").Optional().Nillable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of Subscriber.
func (Subscriber) Indexes() []ent.Index {
	return []ent.Index{
		// The list is per site and one address appears once.
		index.Fields("site_id", "email").Unique(),
		// Confirmation and unsubscribe links are looked up by hash alone.
		index.Fields("token_hash").Unique(),
		// The admin list filters by state and pages newest first.
		index.Fields("site_id", "status", "created_at"),
	}
}
