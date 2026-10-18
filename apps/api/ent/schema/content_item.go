package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Content kind values.
const (
	ContentKindArticle = "article"
	ContentKindPost    = "post"
)

// Content status values. They mirror the review state machine in the content
// package; the database only stores the current position.
const (
	ContentStatusDraft                = "draft"
	ContentStatusPendingReview        = "pending_review"
	ContentStatusPublished            = "published"
	ContentStatusRejected             = "rejected"
	ContentStatusArchived             = "archived"
	ContentStatusPendingSecurityCheck = "pending_security_check"
)

// ContentItem is one article or post.
//
// Articles and posts share a table discriminated by kind instead of two near
// identical tables. The two differ only in which fields are meaningful (a post has
// no title requirement), and every query is already scoped by site and status, so a
// single table keeps the repository, the indexes and the state machine uniform.
//
// The current revision is stored inline. A revision history table is added when
// editing history becomes a requirement; storing it now would duplicate every field
// on every edit for a feature nothing reads yet.
type ContentItem struct{ ent.Schema }

// Fields of ContentItem.
func (ContentItem) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("author_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("kind").
			Validate(oneOf(ContentKindArticle, ContentKindPost)).
			Immutable(),
		field.String("status").
			Default(ContentStatusDraft).
			Validate(oneOf(
				ContentStatusDraft, ContentStatusPendingReview, ContentStatusPublished,
				ContentStatusRejected, ContentStatusArchived, ContentStatusPendingSecurityCheck,
			)),
		field.String("title").MaxLen(200).NotEmpty(),
		field.String("slug").MaxLen(120).Default(""),
		field.String("summary").MaxLen(500).Default(""),
		field.String("source_format").
			Default("markdown").
			Validate(oneOf("markdown", "html", "plain")),
		field.Text("source_body"),
		field.Text("rendered_html").Default(""),
		field.String("policy_version").MaxLen(64).Default(""),
		field.String("category_id").MaxLen(36).Optional().Nillable(),
		field.Time("published_at").Optional().Nillable(),
		field.Time("archived_at").Optional().Nillable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of ContentItem.
func (ContentItem) Indexes() []ent.Index {
	return []ent.Index{
		// Public listing: site, status, newest first.
		index.Fields("site_id", "status", "published_at"),
		// Author's own work list.
		index.Fields("author_id", "status"),
		// Slug lookup inside a site.
		index.Fields("site_id", "slug"),
	}
}
