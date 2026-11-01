package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// SiteCustomization stores the design of one site: theme tokens, layout, the page
// builder's pages and blocks, custom CSS, pinned articles and covers.
//
// It is its own table rather than a column on Site for two reasons. The document is
// large (hundreds of kilobytes once a site has a few pages), and reading it must not be
// a side effect of every query that loads a site; and it changes on a completely
// different cadence than the site's identity, which is what a diffable row buys.
//
// The document itself is opaque text: it is validated and size capped by the service,
// never by the database, so the same model stays valid on SQLite, MySQL and PostgreSQL.
type SiteCustomization struct{ ent.Schema }

// Fields of SiteCustomization.
func (SiteCustomization) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		// document is the JSON payload exactly as the browser sent it.
		field.Text("document"),
		// revision increments on every accepted write. A client that sends a stale
		// revision gets a conflict instead of silently overwriting an edit made in
		// another tab or by another administrator.
		field.Int("revision").Default(1),
		createdField(),
		updatedField(),
	}
}

// Indexes of SiteCustomization.
func (SiteCustomization) Indexes() []ent.Index {
	return []ent.Index{
		// A site has exactly one design, which makes the write an upsert keyed by site.
		index.Fields("site_id").Unique(),
	}
}
