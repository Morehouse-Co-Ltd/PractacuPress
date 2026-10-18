package site

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRoleAuthorityIsOrdered(t *testing.T) {
	roles := []Role{RolePlatformAdmin, RoleSiteAdmin, RoleEditor, RoleMember}
	for i := 1; i < len(roles); i++ {
		require.Greater(t, roles[i-1].Authority(), roles[i].Authority(),
			"%s must outrank %s", roles[i-1], roles[i])
	}
	require.True(t, RolePlatformAdmin.AtLeast(RoleSiteAdmin))
	require.True(t, RoleSiteAdmin.AtLeast(RoleSiteAdmin))
	require.False(t, RoleEditor.AtLeast(RoleSiteAdmin))
	require.False(t, RoleMember.AtLeast(RoleEditor))
}

func TestUnknownRoleGrantsNothing(t *testing.T) {
	var r Role = "superuser"
	require.False(t, r.Valid())
	require.False(t, r.AtLeast(RoleMember))
}

func TestValidateForServing(t *testing.T) {
	verified := time.Now().UTC()

	cases := []struct {
		name string
		site Site
		host string
		want error
	}{
		{
			name: "verified matching host",
			site: Site{Domain: "example.com", DomainVerifiedAt: &verified},
			host: "example.com",
			want: nil,
		},
		{
			name: "case and trailing dot insensitive",
			site: Site{Domain: "Example.COM", DomainVerifiedAt: &verified},
			host: "example.com.",
			want: nil,
		},
		{
			name: "unverified domain is refused",
			site: Site{Domain: "example.com"},
			host: "example.com",
			want: ErrDomainUnverified,
		},
		{
			name: "different host is not found",
			site: Site{Domain: "example.com", DomainVerifiedAt: &verified},
			host: "evil.com",
			want: ErrNotFound,
		},
		{
			name: "disabled site refuses even a matching host",
			site: Site{Domain: "example.com", DomainVerifiedAt: &verified, Disabled: true},
			host: "example.com",
			want: ErrDisabled,
		},
		{
			name: "site without a domain serves any host",
			site: Site{},
			host: "any.test",
			want: nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.site.ValidateForServing(tc.host)
			if tc.want == nil {
				require.NoError(t, err)
				return
			}
			require.ErrorIs(t, err, tc.want)
		})
	}
}

func TestIsMembersOnly(t *testing.T) {
	require.True(t, Site{VisibilityMode: VisibilityMembersOnly}.IsMembersOnly())
	require.False(t, Site{VisibilityMode: VisibilityPublic}.IsMembersOnly())
	require.False(t, Site{}.IsMembersOnly())
}
