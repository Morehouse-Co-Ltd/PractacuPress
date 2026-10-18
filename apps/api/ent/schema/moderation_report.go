package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ModerationReport is one filed report against a piece of content or an account.
type ModerationReport struct{ ent.Schema }

// Fields of ModerationReport.
func (ModerationReport) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("reporter_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("target_type").MaxLen(20).NotEmpty().Immutable(),
		field.String("target_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("reason").MaxLen(20).Validate(oneOf("spam", "abuse", "illegal", "other")),
		field.Text("note").Optional(),
		field.String("status").
			Default("open").
			Validate(oneOf("open", "assigned", "resolved", "dismissed")),
		field.String("assignee_id").MaxLen(36).Optional().Nillable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of ModerationReport.
func (ModerationReport) Indexes() []ent.Index {
	return []ent.Index{
		// The queue view: open reports of a site, oldest first.
		index.Fields("site_id", "status", "created_at"),
		// One person should not be able to bury the queue with duplicates of the same
		// target, so the pair is unique per reporter.
		index.Fields("reporter_id", "target_type", "target_id").Unique(),
		index.Fields("assignee_id"),
	}
}
