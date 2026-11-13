package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Sensitive word match modes.
const (
	SensitiveWordReject  = "reject"
	SensitiveWordReplace = "replace"
	SensitiveWordReview  = "review"
)

// SensitiveWord is one site level word the content safety filter acts on.
//
// The word is stored normalised (trimmed and lower-cased) so a second submission of
// the same spelling cannot create a duplicate row. The original casing is irrelevant
// for matching because the filter compares normalised text.
//
// It is a dedicated table rather than a JSON column on sites: the admin screen edits
// one word at a time, hits are audited per word, and the row count is bounded by what
// an administrator actually maintains.
type SensitiveWord struct{ ent.Schema }

// Fields of SensitiveWord.
func (SensitiveWord) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("word").MaxLen(100).NotEmpty(),
		// Mode decides what happens when the word matches: reject refuses the write,
		// replace rewrites the matched text to the placeholder, review stores the
		// submission as pending review.
		field.String("mode").
			Default(SensitiveWordReject).
			Validate(oneOf(SensitiveWordReject, SensitiveWordReplace, SensitiveWordReview)),
		// Replacement is the placeholder written in replace mode. It is stored per row
		// so a site can use a neutral marker instead of asterisks.
		field.String("replacement").MaxLen(80).Default("***"),
		field.Bool("enabled").Default(true),
		createdField(),
		updatedField(),
	}
}

// Indexes of SensitiveWord.
func (SensitiveWord) Indexes() []ent.Index {
	return []ent.Index{
		// One row per spelling per site; the write path upserts on this key.
		index.Fields("site_id", "word").Unique(),
	}
}
