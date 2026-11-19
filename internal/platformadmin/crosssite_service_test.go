package platformadmin

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
)

type fakeMetrics struct {
	metrics DeploymentMetrics
	since   time.Time
	calls   int
	err     error
}

func (f *fakeMetrics) Metrics(_ context.Context, since time.Time) (DeploymentMetrics, error) {
	f.calls++
	f.since = since
	if f.err != nil {
		return DeploymentMetrics{}, f.err
	}
	return f.metrics, nil
}

type fakeDirectory struct {
	items []AccountSummary
	next  string
	query AccountQuery
	limit int
	after page.Cursor
	calls int
	err   error
}

func (f *fakeDirectory) ListAccounts(
	_ context.Context,
	query AccountQuery,
	limit int,
	after page.Cursor,
) ([]AccountSummary, string, error) {
	f.calls++
	f.query = query
	f.limit = limit
	f.after = after
	if f.err != nil {
		return nil, "", f.err
	}
	return f.items, f.next, nil
}

type fakeTrail struct {
	items  []audit.Log
	next   string
	filter audit.Filter
	limit  int
	after  page.Cursor
	calls  int
	err    error
}

func (f *fakeTrail) ListAll(
	_ context.Context,
	filter audit.Filter,
	limit int,
	after page.Cursor,
) ([]audit.Log, string, error) {
	f.calls++
	f.filter = filter
	f.limit = limit
	f.after = after
	if f.err != nil {
		return nil, "", f.err
	}
	return f.items, f.next, nil
}

type fakeRecorder struct {
	entries []audit.Entry
	err     error
}

func (f *fakeRecorder) Record(_ context.Context, entry audit.Entry) error {
	f.entries = append(f.entries, entry)
	return f.err
}

// crossSiteService builds a Service whose cross-site ports are the fakes above.
func newCrossSiteService(
	t *testing.T,
	repo *fakeRepo,
) (*Service, *fakeMetrics, *fakeDirectory, *fakeTrail, *fakeRecorder) {
	t.Helper()
	issuer, _, err := auth.NewTokenIssuer(config.Config{
		AppEnv:        config.EnvTest,
		AuthJWTIssuer: "platform-test",
	})
	require.NoError(t, err)

	metrics := &fakeMetrics{}
	directory := &fakeDirectory{}
	trail := &fakeTrail{}
	recorder := &fakeRecorder{}
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Accounts:   &fakeAccounts{},
		Sessions:   &fakeSessions{},
		Tokens:     issuer,
		Domains:    &fakeDomains{},
		Metrics:    metrics,
		Directory:  directory,
		Trail:      trail,
		Recorder:   recorder,
	})
	require.NoError(t, err)
	return service, metrics, directory, trail, recorder
}

func twoSiteMetrics(now time.Time) DeploymentMetrics {
	verified := now.Add(-48 * time.Hour)
	return DeploymentMetrics{
		Sites: []SiteMetrics{
			{
				Site: site.Site{
					ID: "site-a", Slug: "a", Name: "Alpha", Domain: "a.example",
					DomainVerifiedAt: &verified, CreatedAt: now.Add(-100 * time.Hour),
				},
				Members: 3, ActiveMembers: 2, Admins: 1,
				Content:        ContentCounts{Total: 5, Published: 3, Pending: 1, Draft: 1},
				Comments:       CommentCounts{Total: 9, Pending: 2},
				OpenReports:    1,
				RecentActivity: 4,
				RecentFailures: 2,
			},
			{
				Site: site.Site{
					ID: "site-b", Slug: "b", Name: "Bravo", Domain: "b.example",
					Disabled: true, CreatedAt: now.Add(-50 * time.Hour),
				},
				Members: 2, ActiveMembers: 1, Admins: 1,
				Content:     ContentCounts{Total: 2, Published: 1, Pending: 0, Draft: 1},
				Comments:    CommentCounts{Total: 3, Pending: 1},
				OpenReports: 2,
			},
		},
		Accounts: AccountCounts{Total: 4, Verified: 3, TwoFactor: 1},
	}
}

func TestOverviewRequiresPlatformAdmin(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "editor", site.RoleEditor, site.MemberStatusActive)
	service, metrics, _, _, _ := newCrossSiteService(t, repo)

	_, err := service.Overview(context.Background(), "site-a", "editor", 7)
	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Zero(t, metrics.calls, "a refused caller must not reach storage")
}

func TestOverviewSumsSitesAndSignals(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, metrics, _, trail, _ := newCrossSiteService(t, repo)

	fixed := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return fixed }
	metrics.metrics = twoSiteMetrics(fixed)
	trail.items = []audit.Log{
		{ID: "log-1", SiteID: "site-a", Action: "auth.login", Outcome: "success"},
		{ID: "log-2", SiteID: "site-unknown", Action: "platform.site.created"},
	}

	overview, err := service.Overview(context.Background(), "site-a", "root", 7)
	require.NoError(t, err)

	require.Equal(t, 7, overview.WindowDays)
	require.Equal(t, fixed, overview.GeneratedAt)
	require.Equal(t, fixed.AddDate(0, 0, -7), overview.WindowStart)
	require.Equal(t, fixed.AddDate(0, 0, -7), metrics.since)

	require.Equal(t, 2, overview.Totals.Sites)
	require.Equal(t, 5, overview.Totals.Members)
	require.Equal(t, 3, overview.Totals.ActiveMembers)
	require.Equal(t, 2, overview.Totals.Admins)
	require.Equal(t, 7, overview.Totals.Content)
	require.Equal(t, 4, overview.Totals.PublishedContent)
	require.Equal(t, 1, overview.Totals.PendingContent)
	require.Equal(t, 12, overview.Totals.Comments)
	require.Equal(t, 3, overview.Totals.PendingComments)
	require.Equal(t, 4, overview.Totals.Accounts)
	require.Equal(t, 3, overview.Totals.VerifiedAccounts)
	require.Equal(t, 1, overview.Totals.TwoFactorChosen)
	require.Equal(t, 1, overview.Totals.DisabledSites)
	require.Equal(t, 1, overview.Totals.UnverifiedSites)

	require.Equal(t, 3, overview.Signals.OpenReports)
	require.Equal(t, 3, overview.Signals.PendingComments)
	require.Equal(t, 2, overview.Signals.FailedActions)
	require.Equal(t, 1, overview.Signals.DisabledSites)
	require.Equal(t, 1, overview.Signals.UnverifiedSites)
	require.Equal(t, 1, overview.Signals.UnverifiedEmails)
	// site-b is disabled, so its silence is not a signal; site-a did act.
	require.Equal(t, 0, overview.Signals.QuietSites)

	require.Len(t, overview.Recent, 2)
	require.Equal(t, "Alpha", overview.Recent[0].SiteName)
	require.Empty(t, overview.Recent[1].SiteName, "a site-less row carries no label")
	require.NotNil(t, trail.filter.From, "the overview window bounds the recent rows")
	require.Empty(t, trail.filter.SiteID, "the recent rows cross sites on purpose")
	require.Equal(t, MaxRecentActivity, trail.limit)
}

func TestOverviewRejectsWindowOutsideBounds(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, metrics, _, _, _ := newCrossSiteService(t, repo)

	_, err := service.Overview(context.Background(), "site-a", "root", MaxOverviewWindowDays+1)
	require.ErrorIs(t, err, ErrInvalidInput)
	require.Zero(t, metrics.calls)
}

func TestListAuditLogsCrossesSitesAndAuditsTheQuery(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, _, _, trail, recorder := newCrossSiteService(t, repo)

	trail.items = []audit.Log{{ID: "log-2", SiteID: "site-b", Action: "content.published"}}
	trail.next = "cursor-2"

	result, err := service.ListAuditLogs(
		context.Background(),
		"site-a",
		"root",
		"req-9",
		AuditQuery{SiteID: "site-b", Action: "content.published", Outcome: "success"},
		25,
		page.Cursor{},
	)
	require.NoError(t, err)
	require.Len(t, result.Items, 1)
	require.Equal(t, "cursor-2", result.NextCursor)
	require.Equal(t, "site-b", trail.filter.SiteID)
	require.Equal(t, "content.published", trail.filter.Action)
	require.Equal(t, "success", trail.filter.Outcome)
	require.Equal(t, 25, trail.limit)

	require.Len(t, recorder.entries, 1)
	entry := recorder.entries[0]
	require.Equal(t, "platform.audit.queried", entry.Action)
	require.Equal(t, "site-a", entry.SiteID)
	require.Equal(t, "root", entry.ActorID)
	require.Equal(t, "req-9", entry.RequestID)
	require.Equal(t, "site-b", entry.TargetID)
	require.Equal(t, 1, entry.Detail["returned"])
	require.Equal(t, "site-b", entry.Detail["site_id"])
}

func TestListAuditLogsEmptySiteMeansEverySite(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, _, _, trail, recorder := newCrossSiteService(t, repo)

	_, err := service.ListAuditLogs(context.Background(), "site-a", "root", "", AuditQuery{}, 0, page.Cursor{})
	require.NoError(t, err)
	require.Empty(t, trail.filter.SiteID)
	require.Equal(t, audit.DefaultLimit, trail.limit, "an omitted limit takes the default page size")
	require.Equal(t, "site-a", recorder.entries[0].TargetID,
		"an unfiltered query targets the actor's own site")
}

func TestListAuditLogsFailsWhenTheQueryCannotBeAudited(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, _, _, _, recorder := newCrossSiteService(t, repo)
	recorder.err = errors.New("audit table is read only")

	_, err := service.ListAuditLogs(context.Background(), "site-a", "root", "", AuditQuery{}, 10, page.Cursor{})
	require.Error(t, err, "an unrecorded privileged read must not be served")
}

func TestListAuditLogsRejectsMalformedFilters(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, _, _, trail, _ := newCrossSiteService(t, repo)

	from := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	to := from.Add(-time.Hour)
	_, err := service.ListAuditLogs(context.Background(), "site-a", "root", "", AuditQuery{
		From: &from,
		To:   &to,
	}, 0, page.Cursor{})
	require.ErrorIs(t, err, ErrInvalidInput)
	require.Zero(t, trail.calls)

	_, err = service.ListAuditLogs(context.Background(), "site-a", "root", "", AuditQuery{
		Action: string(make([]byte, audit.MaxActionLength+1)),
	}, 0, page.Cursor{})
	require.ErrorIs(t, err, ErrInvalidInput)
	require.Zero(t, trail.calls)
}

func TestListAccountsRequiresPlatformAdmin(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "editor", site.RoleEditor, site.MemberStatusActive)
	service, _, directory, _, _ := newCrossSiteService(t, repo)

	_, err := service.ListAccounts(context.Background(), "site-a", "editor", AccountQuery{}, 10, page.Cursor{})
	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Zero(t, directory.calls)
}

func TestListAccountsNormalizesThePage(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, _, directory, _, _ := newCrossSiteService(t, repo)

	directory.items = []AccountSummary{{UserID: "user-1", DisplayName: "Root"}}
	directory.next = "cursor-2"

	result, err := service.ListAccounts(
		context.Background(),
		"site-a",
		"root",
		AccountQuery{SiteID: " site-b ", Search: "  root  "},
		0,
		page.Cursor{},
	)
	require.NoError(t, err)
	require.Len(t, result.Items, 1)
	require.Equal(t, "cursor-2", result.NextCursor)
	require.Equal(t, "site-b", directory.query.SiteID)
	require.Equal(t, "root", directory.query.Search)
	require.Equal(t, DefaultAccountPageLimit, directory.limit)

	_, err = service.ListAccounts(
		context.Background(),
		"site-a",
		"root",
		AccountQuery{Search: string(make([]rune, MaxDirectorySearchLength+1))},
		MaxAccountPageLimit+50,
		page.Cursor{},
	)
	require.ErrorIs(t, err, ErrInvalidInput)
}
