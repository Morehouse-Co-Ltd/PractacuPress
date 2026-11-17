package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// EmailTemplate is one editable message the installation can send.
//
// The shipped defaults are code constants; a row here overrides one of them for a
// site. key is the stable identifier the sending code uses (for example
// "newsletter_welcome" or "subscriber_confirm"), so renaming the template never
// breaks a send path. body_html is sanitized by the security service before it is
// stored, because a template is rendered into a mail body that the operator builds
// from the dashboard.
type EmailTemplate struct{ ent.Schema }

// Fields of EmailTemplate.
func (EmailTemplate) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("key").MaxLen(80).NotEmpty(),
		field.String("name").MaxLen(120).Default(""),
		field.String("subject").MaxLen(300).Default(""),
		field.Text("body_html").Default(""),
		field.Text("body_text").Default(""),
		// enabled=false keeps an override around while sending falls back to the
		// built-in default, which is how an operator can disable a customisation
		// without losing it.
		field.Bool("enabled").Default(true),
		createdField(),
		updatedField(),
	}
}

// Indexes of EmailTemplate.
func (EmailTemplate) Indexes() []ent.Index {
	return []ent.Index{
		// One override per key inside a site.
		index.Fields("site_id", "key").Unique(),
	}
}
