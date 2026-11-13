package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// SiteConfig stores the site-level configuration that used to live only in the
// site owner's browser: access limits, bound domains, frontend performance
// switches, the loading screen and the enabled login providers.
//
// It is its own table rather than a column on Site, and separate from
// SiteCustomization, for two reasons:
//
//   - It is read on every boot by every visitor but is much smaller than the
//     design document, and the two change on different cadences (a rate limit
//     tweak must not walk a page tree).
//   - It has an audience split. The design document is one document every
//     visitor receives; this one has fields a visitor needs (access rules,
//     loading screen) and fields only an administrator may see (TLS certificate
//     paths, trusted proxies, CORS origins, OAuth client ids). Keeping the whole
//     document in one opaque row and projecting the public subset in the service
//     keeps that filtering in one place.
//
// The document itself is opaque text: it is validated and size capped by the
// service, never by the database, so the same model stays valid on SQLite,
// MySQL and PostgreSQL.
type SiteConfig struct{ ent.Schema }

// Fields of SiteConfig.
func (SiteConfig) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		// document is the JSON payload exactly as the browser sent it.
		field.Text("document"),
		// revision increments on every accepted write, mirroring
		// SiteCustomization.revision: a stale client gets a conflict instead of
		// silently overwriting a change made in another tab or on another device.
		field.Int("revision").Default(1),
		createdField(),
		updatedField(),
	}
}

// Indexes of SiteConfig.
func (SiteConfig) Indexes() []ent.Index {
	return []ent.Index{
		// A site has exactly one configuration, which makes the write an upsert
		// keyed by site.
		index.Fields("site_id").Unique(),
	}
}
