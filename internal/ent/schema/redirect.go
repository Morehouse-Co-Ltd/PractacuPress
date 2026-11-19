package schema

import (
	"fmt"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Redirect sources. A manual rule is written by an administrator; a slug change is
// written by the content service when a published item's permalink moves, so a link
// that was shared yesterday keeps working; import marks rules that arrived with a
// migration package.
const (
	RedirectSourceManual     = "manual"
	RedirectSourceSlugChange = "slug_change"
	RedirectSourceImport     = "import"
)

// Redirect is one permanent or temporary URL rule scoped to a site.
//
// from_path is stored normalised (leading slash, no query, no trailing slash except
// the root) so a lookup is an exact match rather than a prefix scan. The table is
// deliberately small and read on every page resolution miss, which is why the site
// and path pair is unique.
type Redirect struct{ ent.Schema }

// Fields of Redirect.
func (Redirect) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		// from_path is the incoming path, for example "/a/old-title".
		field.String("from_path").MaxLen(512).NotEmpty(),
		// to_path is either a site relative path or an absolute URL.
		field.String("to_path").MaxLen(512).NotEmpty(),
		field.Int("status_code").
			Default(301).
			Validate(func(code int) error {
				if code != 301 && code != 302 && code != 308 {
					return fmt.Errorf("must be one of: 301, 302, 308")
				}
				return nil
			}),
		field.String("source").
			Default(RedirectSourceManual).
			Validate(oneOf(RedirectSourceManual, RedirectSourceSlugChange, RedirectSourceImport)),
		// hit_count is a coarse popularity signal for the admin list; it is not part
		// of any report and is incremented on a best effort basis.
		field.Int("hit_count").NonNegative().Default(0),
		createdField(),
		updatedField(),
	}
}

// Indexes of Redirect.
func (Redirect) Indexes() []ent.Index {
	return []ent.Index{
		// One rule per incoming path inside a site; a second rule for the same path
		// would make resolution order dependent.
		index.Fields("site_id", "from_path").Unique(),
		index.Fields("site_id", "created_at"),
	}
}
