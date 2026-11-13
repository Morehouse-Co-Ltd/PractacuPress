package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// IP rule kinds.
const (
	IPRuleAllow = "allow"
	IPRuleDeny  = "deny"
)

// SiteIPRule is one address or CIDR block on a site's allow or deny list.
//
// Rules are keyed by the host-resolved site, not by the caller: the same client
// address can be refused on one site and accepted on another. A deny rule always
// wins; a non-empty allow list additionally restricts the site to the listed
// addresses. Loopback is exempted by the service so an operator cannot lock
// themselves out of a desktop install.
type SiteIPRule struct{ ent.Schema }

// Fields of SiteIPRule.
func (SiteIPRule) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("kind").Validate(oneOf(IPRuleAllow, IPRuleDeny)),
		// Value is a single IPv4/IPv6 address or a CIDR block. It is validated by the
		// service with net.ParseIP / net.ParseCIDR before the row is written.
		field.String("value").MaxLen(64).NotEmpty(),
		field.String("note").MaxLen(200).Optional().Nillable(),
		createdField(),
	}
}

// Indexes of SiteIPRule.
func (SiteIPRule) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("site_id", "kind", "value").Unique(),
	}
}
