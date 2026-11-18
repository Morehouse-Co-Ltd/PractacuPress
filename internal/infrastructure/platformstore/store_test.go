package platformstore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	entgen "github.com/practacu/practacu-press/ent"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/infrastructure/platformstore"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/platformadmin"
)

type fixture struct {
	store   *platformstore.Store
	client  *entgen.Client
	console string
	second  string
	admin   string
	member  string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	ctx := context.Background()
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "platform.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))
	client := handle.Client

	console, err := client.Site.Create().
		SetSlug("console").
		SetName("Console").
		SetDomain("console.test").
		SetDomainVerifiedAt(time.Now().UTC()).
		Save(ctx)
	require.NoError(t, err)
	second, err := client.Site.Create().SetSlug("second").SetName("Second").Save(ctx)
	require.NoError(t, err)

	admin, err := client.User.Create().
		SetDisplayName("Ada Admin").
		SetEmailVerifiedAt(time.Now().UTC()).
		Save(ctx)
	require.NoError(t, err)
	member, err := client.User.Create().SetDisplayName("Bob Member").Save(ctx)
	require.NoError(t, err)
	_, err = client.UserIdentity.Create().
		SetUserID(admin.ID).
		SetProvider("email").
		SetProviderSubject("ada@example.test").
		SetEmail("ada@example.test").
		Save(ctx)
	require.NoError(t, err)
	_, err = client.UserIdentity.Create().
		SetUserID(member.ID).
		SetProvider("email").
		SetProviderSubject("bob@example.test").
		SetEmail("bob@example.test").
		Save(ctx)
	require.NoError(t, err)

	for _, membership := range []struct {
		site, user, role string
	}{
		{console.ID, admin.ID, "platform_admin"},
		{console.ID, member.ID, "member"},
		{second.ID, admin.ID, "platform_admin"},
	} {
		_, err := client.SiteMember.Create().
			SetSiteID(membership.site).
			SetUserID(membership.user).
			SetRole(membership.role).
			SetStatus("active").
			Save(ctx)
		require.NoError(t, err)
	}

	now := time.Now().UTC()
	base := now.Add(-2 * time.Hour)
	content := func(siteID, status string) *entgen.ContentItem {
		item, createErr := client.ContentItem.Create().
			SetSiteID(siteID).
			SetAuthorID(admin.ID).
			SetKind("article").
			SetStatus(status).
			SetTitle("Fixture " + status + " " + siteID[:8]).
			SetSlug("fixture-" + status + "-" + siteID[:8]).
			SetSourceBody("body").
			Save(ctx)
		require.NoError(t, createErr)
		return item
	}
	content(console.ID, "published")
	content(console.ID, "published")
	content(console.ID, "pending_review")
	content(second.ID, "published")
	content(second.ID, "draft")

	_, err = client.Comment.Create().
		SetSiteID(console.ID).
		SetAuthorID(member.ID).
		SetTargetType("article").
		SetTargetID(admin.ID).
		SetBody("pending").
		SetStatus("pending_review").
		Save(ctx)
	require.NoError(t, err)

	_, err = client.ModerationReport.Create().
		SetSiteID(console.ID).
		SetReporterID(member.ID).
		SetTargetType("article").
		SetTargetID(admin.ID).
		SetReason("spam").
		SetStatus("open").
		Save(ctx)
	require.NoError(t, err)
	_, err = client.ModerationReport.Create().
		SetSiteID(second.ID).
		SetReporterID(member.ID).
		SetTargetType("article").
		SetTargetID(second.ID).
		SetReason("spam").
		SetStatus("resolved").
		Save(ctx)
	require.NoError(t, err)

	for index, row := range []struct {
		siteID  string
		action  string
		outcome string
	}{
		{console.ID, "auth.login", "success"},
		{console.ID, "auth.captcha.failed", "failure"},
		{second.ID, "content.published", "success"},
	} {
		_, err := client.AuditLog.Create().
			SetSiteID(row.siteID).
			SetAction(row.action).
			SetOutcome(row.outcome).
			SetActorID(admin.ID).
			SetCreatedAt(base.Add(time.Duration(index) * time.Minute)).
			Save(ctx)
		require.NoError(t, err)
	}

	_, err = client.TwoFactor.Create().
		SetUserID(admin.ID).
		SetSecret("sealed").
		SetEnabled(true).
		SetConfirmedAt(now).
		Save(ctx)
	require.NoError(t, err)

	return fixture{
		store:   platformstore.New(client),
		client:  client,
		console: console.ID,
		second:  second.ID,
		admin:   admin.ID,
		member:  member.ID,
	}
}

func TestMetricsCountsEverySiteAndTheDeployment(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	metrics, err := f.store.Metrics(ctx, time.Now().UTC().Add(-24*time.Hour))
	require.NoError(t, err)
	require.Len(t, metrics.Sites, 2)

	byID := make(map[string]platformadmin.SiteMetrics, len(metrics.Sites))
	for _, item := range metrics.Sites {
		byID[item.Site.ID] = item
	}
	console := byID[f.console]
	require.Equal(t, 2, console.Members)
	require.Equal(t, 1, console.Admins)
	require.Equal(t, 3, console.Content.Total)
	require.Equal(t, 2, console.Content.Published)
	require.Equal(t, 1, console.Content.Pending)
	require.Equal(t, 1, console.Comments.Pending)
	require.Equal(t, 1, console.OpenReports)
	require.Equal(t, 2, console.RecentActivity)
	require.Equal(t, 1, console.RecentFailures)

	second := byID[f.second]
	require.Equal(t, 2, second.Content.Total)
	require.Equal(t, 1, second.Content.Published)
	require.Zero(t, second.OpenReports)
	require.Equal(t, 1, second.RecentActivity)

	require.Equal(t, 2, metrics.Accounts.Total)
	require.Equal(t, 1, metrics.Accounts.Verified)
	require.Equal(t, 1, metrics.Accounts.TwoFactor)
}

func TestListAccountsPagesAndSearchesAcrossSites(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	all, next, err := f.store.ListAccounts(ctx, platformadmin.AccountQuery{}, 1, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, all, 1)
	require.NotEmpty(t, next)
	require.NotEmpty(t, all[0].Email)
	require.NotEmpty(t, all[0].Memberships)

	cursor, err := page.Decode(next)
	require.NoError(t, err)
	secondPage, last, err := f.store.ListAccounts(ctx, platformadmin.AccountQuery{}, 1, cursor)
	require.NoError(t, err)
	require.Len(t, secondPage, 1)
	require.Empty(t, last)
	require.NotEqual(t, all[0].UserID, secondPage[0].UserID)
}

func TestListAccountsSearchMatchesNameAndEmail(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	byName, _, err := f.store.ListAccounts(ctx, platformadmin.AccountQuery{Search: "bob"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byName, 1)
	require.Equal(t, f.member, byName[0].UserID)

	byEmail, _, err := f.store.ListAccounts(ctx, platformadmin.AccountQuery{Search: "ada@example"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byEmail, 1)
	require.Equal(t, f.admin, byEmail[0].UserID)

	none, _, err := f.store.ListAccounts(ctx, platformadmin.AccountQuery{Search: "nobody"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Empty(t, none)
}

// TestListSiteMembersSearchesDisplayNames is the regression for the site filtered
// page: before it only matched the email identity, so typing a display name after
// choosing a site returned an empty page.
func TestListSiteMembersSearchesDisplayNames(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	byName, _, err := f.store.ListAccounts(ctx,
		platformadmin.AccountQuery{SiteID: f.second, Search: "Ada"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byName, 1)
	require.Equal(t, f.admin, byName[0].UserID)
	require.Len(t, byName[0].Memberships, 2)
	var secondMembership *platformadmin.AccountMembership
	for index := range byName[0].Memberships {
		if byName[0].Memberships[index].SiteID == f.second {
			secondMembership = &byName[0].Memberships[index]
		}
	}
	require.NotNil(t, secondMembership)
	require.Equal(t, "platform_admin", string(secondMembership.Role))
	require.Equal(t, "Second", secondMembership.SiteName)

	byEmail, _, err := f.store.ListAccounts(ctx,
		platformadmin.AccountQuery{SiteID: f.second, Search: "ada@example"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byEmail, 1)

	none, _, err := f.store.ListAccounts(ctx,
		platformadmin.AccountQuery{SiteID: f.second, Search: "Bob"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Empty(t, none)
}

func TestAccountDetailsLeakNoSecret(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	items, _, err := f.store.ListAccounts(ctx,
		platformadmin.AccountQuery{SiteID: f.console}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, items, 2)

	var admin platformadmin.AccountSummary
	for _, item := range items {
		if item.UserID == f.admin {
			admin = item
		}
	}
	require.True(t, admin.EmailVerified)
	require.True(t, admin.TwoFactorEnabled)
	require.Equal(t, "ada@example.test", admin.Email)
	// AccountSummary carries no field for a password hash, sealed secret or token:
	// the type itself is the guarantee, and the fixture's secret never comes back.
	for _, item := range items {
		require.NotContains(t, item.Email, "sealed")
	}
}
