package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Identity provider values. Email and phone are treated as identities too, which
// is what lets one user bind several login methods (design §7.3 rule 4).
const (
	ProviderEmail  = "email"
	ProviderPhone  = "phone"
	ProviderGoogle = "google"
	ProviderGitHub = "github"
	ProviderWeChat = "wechat"
)

// UserIdentity binds a login method to a user.
//
// The provider subject is stored separately from the display name so a provider
// rename never changes how a user is shown.
type UserIdentity struct{ ent.Schema }

// Fields of UserIdentity.
func (UserIdentity) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("user_id").MaxLen(36).NotEmpty(),
		field.String("provider").
			Validate(oneOf(ProviderEmail, ProviderPhone, ProviderGoogle, ProviderGitHub, ProviderWeChat)),
		field.String("provider_subject").MaxLen(255).NotEmpty(),
		field.String("email").MaxLen(320).Optional().Nillable(),
		field.String("phone").MaxLen(32).Optional().Nillable(),
		// password_hash holds a PHC formatted hash produced by the security service.
		// It is empty for pure OAuth identities.
		field.String("password_hash").MaxLen(255).Optional().Nillable().Sensitive(),
		field.Time("verified_at").Optional().Nillable(),
		createdField(),
		updatedField(),
	}
}

// Indexes of UserIdentity.
func (UserIdentity) Indexes() []ent.Index {
	return []ent.Index{
		// One identity belongs to exactly one user, and one provider subject is
		// never shared between users.
		index.Fields("provider", "provider_subject").Unique(),
		index.Fields("user_id"),
		index.Fields("email"),
		index.Fields("phone"),
	}
}
