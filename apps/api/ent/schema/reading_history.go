package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ReadingHistory is the last time one user opened one content item.
//
// It is deliberately keyed by user and target rather than by page path: the page
// view table stores an anonymous session id, which cannot be turned back into an
// account without guessing. One row per user and target keeps the table bounded by
// the size of the catalogue instead of growing with every reload, and the view
// counter preserves how often the item was opened.
type ReadingHistory struct{ ent.Schema }

// Fields of ReadingHistory.
func (ReadingHistory) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("user_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("target_type").MaxLen(20).NotEmpty().Immutable(),
		field.String("target_id").MaxLen(36).NotEmpty().Immutable(),
		// last_viewed_at moves forward on every visit, so the list reads as a
		// "recently read" order.
		field.Time("last_viewed_at"),
		// view_count is a positive counter. Zero is only possible for rows written
		// by a future migration; the service always starts at one.
		field.Int("view_count").NonNegative().Default(0),
		createdField(),
	}
}

// Indexes of ReadingHistory.
func (ReadingHistory) Indexes() []ent.Index {
	return []ent.Index{
		// One row per user and target; the write path upserts on this key.
		index.Fields("user_id", "target_type", "target_id").Unique(),
		// The "recently read" page.
		index.Fields("site_id", "user_id", "last_viewed_at"),
	}
}
