package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Follow is a directed relationship from one user to another within a site.
type Follow struct{ ent.Schema }

// Fields of Follow.
func (Follow) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("follower_id").MaxLen(36).NotEmpty().Immutable(),
		field.String("followee_id").MaxLen(36).NotEmpty().Immutable(),
		createdField(),
	}
}

// Indexes of Follow.
func (Follow) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("site_id", "follower_id", "followee_id").Unique(),
		index.Fields("site_id", "followee_id"),
	}
}
