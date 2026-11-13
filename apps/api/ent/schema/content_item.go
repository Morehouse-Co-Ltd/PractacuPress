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

// Content access modes decide who may read a published item (C-18).
const (
	ContentAccessPublic   = "public"
	ContentAccessPassword = "password"
	ContentAccessMembers  = "members"
)

// Per item comment policies override the site level switches (C-19).
const (
	ContentCommentPolicyInherit  = "inherit"
	ContentCommentPolicyOpen     = "open"
	ContentCommentPolicyDisabled = "disabled"
	ContentCommentPolicyReview   = "review"
)

// ContentItem is one article or post.
//
// Articles and posts share a table discriminated by kind instead of two near
// identical tables. The two differ only in which fields are meaningful (a post has
// no title requirement), and every query is already scoped by site and status, so a
// single table keeps the repository, the indexes and the state machine uniform.
//
// The current revision is stored inline; ContentRevision keeps the bounded
// history of previous states that the editor can inspect and restore.
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
		// revision is the current version number. Every save increments it under
		// an optimistic condition, so a stale editor cannot overwrite a newer
		// write, and the revision history can be numbered without a second query.
		field.Int("revision").NonNegative().Default(0),
		field.String("category_id").MaxLen(36).Optional().Nillable(),
		// Tags are a JSON encoded array of short labels. They are not queried as a
		// set yet, so a JSON column keeps the portable schema free of join tables
		// while preserving the order the author chose.
		field.Text("tags").Default("[]"),
		field.Time("published_at").Optional().Nillable(),
		field.Time("archived_at").Optional().Nillable(),
		// publish_at is the scheduled publication instant (C-17). The scheduler
		// promotes a due draft to published; a manual publish clears it.
		field.Time("publish_at").Optional().Nillable(),
		// publish_attempts counts failed scheduler passes so a draft that cannot be
		// published is retried a bounded number of times instead of every tick.
		field.Int("publish_attempts").NonNegative().Default(0),
		// access_mode and access_password_hash implement private/password content
		// (C-18). The password is only ever stored as an Argon2id hash.
		field.String("access_mode").
			Default(ContentAccessPublic).
			Validate(oneOf(ContentAccessPublic, ContentAccessPassword, ContentAccessMembers)),
		field.String("access_password_hash").MaxLen(255).Optional().Nillable(),
		// view_count is the de-duplicated number of reads of a published item. It is
		// a counter column rather than a derived aggregate because every listing and
		// the detail response already load the row, and the "popular" query sorts on
		// it; counting page_view rows on every read would make the list path pay for
		// a group by it never needs. The write is one incrementing UPDATE and never
		// touches any other column, so it cannot lose an edit.
		field.Int("view_count").NonNegative().Default(0),
		// comment_policy is the per item override of the site comment switches
		// (C-19). inherit is the default so existing rows keep the site policy.
		field.String("comment_policy").
			Default(ContentCommentPolicyInherit).
			Validate(oneOf(
				ContentCommentPolicyInherit, ContentCommentPolicyOpen,
				ContentCommentPolicyDisabled, ContentCommentPolicyReview,
			)),
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
		// The scheduler scans for due drafts across the whole deployment.
		index.Fields("publish_at"),
		// The popular leaderboard reads one site's published rows ordered by views.
		// The exact ordering also narrows by publication date, which the existing
		// (site_id, status, published_at) index serves; this one supplies the counter
		// order without a full scan of the site.
		index.Fields("site_id", "status", "view_count"),
	}
}
