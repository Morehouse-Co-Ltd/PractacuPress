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
//
// An email or phone subject and the mirrored email/phone columns are sealed at
// rest with the field cipher (see internal/platform/fieldcrypto). The sealed form
// is longer than the plaintext, which is why these columns allow 512 bytes: a
// 254-byte address becomes a ~380-byte envelope. Email subjects use the
// deterministic envelope so the unique index and login lookups keep working; a
// ciphertext is still the same value for the same address.
type UserIdentity struct{ ent.Schema }

// Fields of UserIdentity.
func (UserIdentity) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("user_id").MaxLen(36).NotEmpty(),
		field.String("provider").
			Validate(oneOf(ProviderEmail, ProviderPhone, ProviderGoogle, ProviderGitHub, ProviderWeChat)),
		field.String("provider_subject").MaxLen(512).NotEmpty(),
		field.String("email").MaxLen(512).Optional().Nillable(),
		field.String("phone").MaxLen(512).Optional().Nillable(),
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
