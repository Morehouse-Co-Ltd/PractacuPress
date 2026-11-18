package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Taxonomy term kinds. Categories and tags share one table because they carry the
// same fields and the same CRUD rules; kind is what tells them apart.
const (
	TaxonomyKindCategory = "category"
	TaxonomyKindTag      = "tag"
)

// TaxonomyTerm is one category or tag of a site.
//
// Content references a category by id (content_item.category_id) and a tag by name
// (the JSON tags array), which is why both name and slug are unique inside a site and
// kind rather than only the id.
type TaxonomyTerm struct{ ent.Schema }

// Fields of TaxonomyTerm.
func (TaxonomyTerm) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("kind").Validate(oneOf(TaxonomyKindCategory, TaxonomyKindTag)).Immutable(),
		field.String("name").MaxLen(80).NotEmpty(),
		field.String("slug").MaxLen(80).NotEmpty(),
		field.String("description").MaxLen(500).Default(""),
		field.String("color").MaxLen(16).Default(""),
		createdField(),
		updatedField(),
	}
}

// Indexes of TaxonomyTerm.
func (TaxonomyTerm) Indexes() []ent.Index {
	return []ent.Index{
		// Same slug for a category and a tag is allowed; two categories may not
		// share one, and the database is what enforces it under concurrency.
		index.Fields("site_id", "kind", "slug").Unique(),
		// Content references a tag by name, so a duplicate name would make the
		// reference ambiguous.
		index.Fields("site_id", "kind", "name").Unique(),
		index.Fields("site_id", "kind"),
	}
}
