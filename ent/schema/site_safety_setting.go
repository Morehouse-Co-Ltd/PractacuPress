package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// SiteSafetySetting is the per-site comment frequency policy.
//
// It is a separate one-row-per-site table instead of more columns on sites: the
// content safety module owns its own defaults and admin endpoints, and a deployment
// that never opens the safety screen needs no backfill. A missing row means the
// service defaults, so an upgraded database behaves exactly like a fresh one.
type SiteSafetySetting struct{ ent.Schema }

// Fields of SiteSafetySetting.
func (SiteSafetySetting) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		// CommentUserLimit bounds new comments per signed-in member per window. Zero
		// disables the signed-in counter; anonymous writes are still counted by IP.
		field.Int("comment_user_limit").NonNegative().Default(5),
		// CommentIPLimit bounds new comments per client address per window, for
		// anonymous and signed-in callers alike. Zero disables the IP counter.
		field.Int("comment_ip_limit").NonNegative().Default(10),
		// CommentWindowSeconds is the fixed window length these counters use.
		field.Int("comment_window_seconds").Positive().Default(60),
		createdField(),
		updatedField(),
	}
}

// Indexes of SiteSafetySetting.
func (SiteSafetySetting) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("site_id").Unique(),
	}
}
