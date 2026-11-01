package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Page view surface values. Public traffic and admin traffic are counted
// separately so the dashboard can report the reader facing numbers only.
const (
	PageViewSurfaceSite  = "site"
	PageViewSurfaceAdmin = "admin"
)

// PageView is one recorded page visit.
//
// The row is an immutable event: it has no updated_at and is never edited. The
// session column is a client supplied random identifier rather than a user id, so a
// visit can be recorded anonymously and still be counted as one unique session.
//
// The table will grow without bound on a busy site. Retention (dropping rows older
// than 30 days) is deliberately left to an operator task instead of a schema hook so
// the write path never pays for cleanup.
type PageView struct{ ent.Schema }

// Fields of PageView.
func (PageView) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("path").MaxLen(2048).NotEmpty(),
		field.String("title").MaxLen(300).Default(""),
		field.String("referrer").MaxLen(2048).Default(""),
		field.String("session").MaxLen(64).NotEmpty(),
		field.String("surface").
			Default(PageViewSurfaceSite).
			Validate(oneOf(PageViewSurfaceSite, PageViewSurfaceAdmin)),
		createdField(),
	}
}

// Indexes of PageView.
func (PageView) Indexes() []ent.Index {
	return []ent.Index{
		// Reporting scans one site's public traffic inside a time window.
		index.Fields("site_id", "surface", "created_at"),
		// Unique session and online counts per site.
		index.Fields("site_id", "session", "created_at"),
	}
}
