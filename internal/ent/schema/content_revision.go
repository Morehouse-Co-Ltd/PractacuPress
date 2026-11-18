package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ContentRevision is one immutable snapshot of a content item.
//
// Every successful save writes one row: the row records what the item looked
// like after the save, so the history is a list of states rather than a change
// log. The item table keeps the current state; this table keeps the last
// RevisionRetention states so an author can inspect and restore them (C-20).
//
// Revision history is deliberately a flat table rather than a foreign key edge:
// content items of both kinds share it, and the design keeps every relation a
// plain indexed column (see common.go).
type ContentRevision struct{ ent.Schema }

// Fields of ContentRevision.
func (ContentRevision) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("content_id").MaxLen(36).NotEmpty().Immutable(),
		// version is the content item's revision number the snapshot describes.
		// It is assigned by the write transaction, so (content_id, version) is
		// unique and doubles as the optimistic concurrency guard.
		field.Int("version").Positive(),
		field.String("editor_id").MaxLen(36).NotEmpty(),
		// action records which write produced the snapshot: created, updated,
		// rollback_backup or rollback.
		field.String("action").MaxLen(32).NotEmpty(),
		// status is the item status at save time, kept so an old version can be
		// read in context even after the live item moved on.
		field.String("status").MaxLen(32).Default(""),
		field.String("title").MaxLen(200).Default(""),
		field.String("slug").MaxLen(120).Default(""),
		field.String("summary").MaxLen(500).Default(""),
		field.String("source_format").
			Default("markdown").
			Validate(oneOf("markdown", "html", "plain")),
		field.Text("source_body"),
		field.Text("rendered_html").Default(""),
		field.String("policy_version").MaxLen(64).Default(""),
		field.String("category_id").MaxLen(36).Optional().Nillable(),
		field.Text("tags").Default("[]"),
		field.Time("created_at").Immutable().Default(nowUTC),
	}
}

// Indexes of ContentRevision.
func (ContentRevision) Indexes() []ent.Index {
	return []ent.Index{
		// One row per version; the unique index is what makes two concurrent
		// saves of the same base revision fail instead of silently overlapping.
		index.Fields("content_id", "version").Unique(),
		// History listing inside a site, newest first.
		index.Fields("site_id", "content_id", "version"),
	}
}
