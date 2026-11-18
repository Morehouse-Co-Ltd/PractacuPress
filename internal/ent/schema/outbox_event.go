package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// OutboxEvent is a reliable asynchronous domain event.
//
// It is written in the same transaction as the business change that produced it,
// then published by a worker. audience_user_id decides who may observe the event:
// empty means the whole site, otherwise only that user. Without it the replay
// endpoint could not be scoped per principal and would leak private messages
// across users of the same site (review P0-2).
type OutboxEvent struct{ ent.Schema }

// Fields of OutboxEvent.
func (OutboxEvent) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		// event_id is the UUIDv7 identifier clients use for resume, kept separate
		// from the row id so the payload key never depends on storage layout.
		field.String("event_id").MaxLen(36).NotEmpty().Immutable(),
		siteIDField(),
		field.String("audience_user_id").MaxLen(36).Optional().Nillable().Immutable(),
		field.String("event_type").MaxLen(80).NotEmpty().Immutable(),
		field.String("aggregate_type").MaxLen(40).NotEmpty().Immutable(),
		field.String("aggregate_id").MaxLen(36).NotEmpty().Immutable(),
		field.JSON("payload", map[string]any{}).Optional(),
		field.Time("occurred_at").Default(nowUTC).Immutable(),
		field.Time("published_at").Optional().Nillable(),
		field.Int("attempts").Default(0).NonNegative(),
		field.Time("next_attempt_at").Optional().Nillable(),
		field.Time("claimed_at").Optional().Nillable(),
		field.String("last_error").MaxLen(500).Optional().Nillable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of OutboxEvent.
func (OutboxEvent) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("event_id").Unique(),
		// Drives the resume query: site scope, audience scope, ordered by event_id.
		index.Fields("site_id", "event_id"),
		index.Fields("audience_user_id", "event_id"),
		// Drives the worker's claim query.
		index.Fields("published_at", "next_attempt_at"),
	}
}
