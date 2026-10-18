package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Site visibility modes.
const (
	VisibilityPublic      = "public"
	VisibilityMembersOnly = "members_only"
)

// Site publish modes.
const (
	PublishModeOpen      = "open"
	PublishModeReview    = "review"
	PublishModeRoleBased = "role_based"
)

// Site is one isolated website: its own content, members, settings and rules.
//
// domain_verified_at is what §7.4 checks before trusting host based resolution; a
// host that has not been proven to belong to the site must not select it.
type Site struct{ ent.Schema }

// Fields of Site.
func (Site) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("slug").MaxLen(64).NotEmpty(),
		field.String("name").MaxLen(160).NotEmpty(),
		field.String("domain").MaxLen(255).Optional().Nillable(),
		field.String("domain_verification_token").MaxLen(64).Optional().Nillable(),
		field.Time("domain_verified_at").Optional().Nillable(),
		field.String("visibility_mode").
			Default(VisibilityPublic).
			Validate(oneOf(VisibilityPublic, VisibilityMembersOnly)),
		field.String("publish_mode").
			Default(PublishModeReview).
			Validate(oneOf(PublishModeOpen, PublishModeReview, PublishModeRoleBased)),
		field.String("description").MaxLen(2000).Optional().Nillable(),
		field.Bool("disabled").Default(false),
		createdField(),
		updatedField(),
	}
}

// Indexes of Site.
func (Site) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("slug").Unique(),
		// A hostname resolves to at most one site. NULL domains are allowed for
		// sites that are only reachable through an explicit site id.
		index.Fields("domain").Unique(),
	}
}
