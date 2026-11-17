package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Page view surface values. Public traffic and admin traffic are counted
// separately so the dashboard can report the reader facing numbers only.
const (
	PageViewSurfaceSite  = "site"
	PageViewSurfaceAdmin = "admin"
)

// Traffic source values, derived on the server from the referrer host. The raw
// referrer string already column exists, but grouping by it would need a wildcard
// match on every report query; the enum is what the source breakdown aggregates.
const (
	PageViewSourceDirect   = "direct"
	PageViewSourceSearch   = "search"
	PageViewSourceSocial   = "social"
	PageViewSourceReferral = "referral"
	PageViewSourceInternal = "internal"
	PageViewSourceUnknown  = "unknown"
)

// Device classes, derived from the User-Agent header at write time.
//
// The user agent itself is never stored: the dashboard only needs "how many mobile
// readers", and keeping a per-visitor fingerprint would turn an anonymous counter
// into a tracking table.
const (
	PageViewDeviceDesktop = "desktop"
	PageViewDeviceMobile  = "mobile"
	PageViewDeviceTablet  = "tablet"
	PageViewDeviceBot     = "bot"
	PageViewDeviceUnknown = "unknown"
)

// PageView is one recorded page visit.
//
// The row is an immutable event: it has no updated_at and is never edited. The
// session column is a client supplied random identifier rather than a user id, so a
// visit can be recorded anonymously and still be counted as one unique session.
//
// The table will grow without bound on a busy site. Retention (dropping rows older
// than 30 days) is deliberately left to an operator task instead of a schema hook so
// the write path never pays for cleanup.
type PageView struct{ ent.Schema }

// Fields of PageView.
func (PageView) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("path").MaxLen(2048).NotEmpty(),
		field.String("title").MaxLen(300).Default(""),
		field.String("referrer").MaxLen(2048).Default(""),
		field.String("session").MaxLen(64).NotEmpty(),
		field.String("surface").
			Default(PageViewSurfaceSite).
			Validate(oneOf(PageViewSurfaceSite, PageViewSurfaceAdmin)),
		// referrer_host is the host of the incoming referrer, lowercased and without
		// scheme or path. Empty for a direct visit.
		field.String("referrer_host").MaxLen(255).Default(""),
		field.String("source").
			Default(PageViewSourceUnknown).
			Validate(oneOf(
				PageViewSourceDirect, PageViewSourceSearch, PageViewSourceSocial,
				PageViewSourceReferral, PageViewSourceInternal, PageViewSourceUnknown,
			)),
		field.String("device").
			Default(PageViewDeviceUnknown).
			Validate(oneOf(
				PageViewDeviceDesktop, PageViewDeviceMobile,
				PageViewDeviceTablet, PageViewDeviceBot, PageViewDeviceUnknown,
			)),
		createdField(),
	}
}

// Indexes of PageView.
func (PageView) Indexes() []ent.Index {
	return []ent.Index{
		// Reporting scans one site's public traffic inside a time window.
		index.Fields("site_id", "surface", "created_at"),
		// Unique session and online counts per site.
		index.Fields("site_id", "session", "created_at"),
		// The source and device breakdowns group over one window.
		index.Fields("site_id", "source", "created_at"),
		index.Fields("site_id", "device", "created_at"),
	}
}
