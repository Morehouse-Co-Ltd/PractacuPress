package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// TwoFactor is the account level TOTP enrollment (FSD F-04).
//
// One row per account, created when the account starts an enrollment and kept
// disabled until a first code confirms it. The secret leaves the auth module only
// in sealed form (AES-256-GCM, see internal/auth/secretbox.go), so a database
// dump does not hand out working authenticator seeds.
//
// last_used_step is the RFC 6238 time step of the most recent successful code.
// Verification only accepts a step strictly greater than this value, which is what
// makes one 30 second code usable exactly once even inside the ±1 drift window.
type TwoFactor struct{ ent.Schema }

// Fields of TwoFactor.
func (TwoFactor) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("user_id").MaxLen(36).NotEmpty().Unique(),
		// Sealed secret: "v1:" plus base64(nonce || AES-GCM ciphertext). The length
		// is generous because the encoding grows with the envelope, not the secret.
		field.String("secret").MaxLen(512).NotEmpty(),
		field.Bool("enabled").Default(false),
		// confirmed_at is when the first valid code proved the authenticator works.
		// It is NULL for an enrollment that was started but never confirmed.
		field.Time("confirmed_at").Optional().Nillable(),
		field.Int64("last_used_step").Default(0),
		createdField(),
		updatedField(),
	}
}

// Indexes of TwoFactor.
func (TwoFactor) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("enabled"),
	}
}

// RecoveryCode is one single use 2FA recovery code.
//
// Only a SHA-256 hash of the code is stored: the plaintext is shown to the account
// owner once, right after enrollment or regeneration, and is unrecoverable
// afterwards. Codes have enough entropy (50 bits) that a plain hash is not
// brute forceable, and a fast hash keeps the lookup index friendly.
type RecoveryCode struct{ ent.Schema }

// Fields of RecoveryCode.
func (RecoveryCode) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		field.String("user_id").MaxLen(36).NotEmpty(),
		field.String("code_hash").MaxLen(64).NotEmpty(),
		field.Time("used_at").Optional().Nillable(),
		createdField(),
	}
}

// Indexes of RecoveryCode.
func (RecoveryCode) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "code_hash").Unique(),
		index.Fields("user_id", "used_at"),
	}
}
