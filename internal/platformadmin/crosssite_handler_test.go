package platformadmin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/infrastructure/auditstore"
	"github.com/practacu/practacu-press/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/infrastructure/platformstore"
	"github.com/practacu/practacu-press/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/platformadmin"
	"github.com/practacu/practacu-press/internal/site"
	ginrouter "github.com/practacu/practacu-press/internal/transport/http/gin"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"

	entgen "github.com/practacu/practacu-press/internal/ent"
)

// The cross-site console is exercised against a real SQLite database: it reads across
// every module's tables, so a fake repository could agree with a bug in the query.
type crossSiteHarness struct {
	router     *gin.Engine
	client     *entgen.Client
	issuer     *auth.TokenIssuer
	consoleID  string
	otherID    string
	rootID     string
	rootTok    string
	siteAdmin  string
	siteAdmTok string
}

func newCrossSiteHarness(t *testing.T) *crossSiteHarness {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "cross-site.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	verified := time.Now().UTC().Add(-time.Hour)
	console, err := handle.Client.Site.Create().
		SetSlug("main").SetName("Main").SetDomain("main.local").
		SetDomainVerifiedAt(verified).Save(ctx)
	require.NoError(t, err)
	// The second site has no verified domain: the overview has to report it as a signal
	// and the cross-site audit table has to show its rows anyway.
	other, err := handle.Client.Site.Create().
		SetSlug("second").SetName("Second").SetDomain("second.local").Save(ctx)
	require.NoError(t, err)

	root, err := handle.Client.User.Create().SetDisplayName("Root").Save(ctx)
	require.NoError(t, err)
	admin, err := handle.Client.User.Create().SetDisplayName("Site Admin").Save(ctx)
	require.NoError(t, err)
	// The reader is a verified account with a confirmed authenticator: the directory has
	// to report both facts as booleans and never the material behind them.
	reader, err := handle.Client.User.Create().
		SetDisplayName("Reader").SetEmailVerifiedAt(verified).Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.UserIdentity.Create().
		SetUserID(root.ID).SetProvider("email").
		SetProviderSubject("root@example.com").SetEmail("root@example.com").
		SetPasswordHash("$argon2id$v=19$m=8,t=1,p=1$c2FsdA$aGFzaA").
		Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.UserIdentity.Create().
		SetUserID(reader.ID).SetProvider("email").
		SetProviderSubject("reader@example.com").SetEmail("reader@example.com").
		SetPasswordHash("$argon2id$v=19$m=8,t=1,p=1$c2FsdA$aGFzaA").
		SetVerifiedAt(verified).
		Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.TwoFactor.Create().
		SetUserID(reader.ID).SetSecret("v1:sealed-secret").SetEnabled(true).
		SetConfirmedAt(verified).Save(ctx)
	require.NoError(t, err)

	for _, membership := range []struct {
		siteID, userID, role string
	}{
		{console.ID, root.ID, string(site.RolePlatformAdmin)},
		{console.ID, reader.ID, string(site.RoleMember)},
		{other.ID, admin.ID, string(site.RoleSiteAdmin)},
		{other.ID, reader.ID, string(site.RoleEditor)},
	} {
		_, err := handle.Client.SiteMember.Create().
			SetSiteID(membership.siteID).SetUserID(membership.userID).
			SetRole(membership.role).SetStatus(site.MemberStatusActive).Save(ctx)
		require.NoError(t, err)
	}

	// Content: two published items and one draft on the console site, one pending item
	// on the second site, so both the inventory and the review backlog are non-zero.
	for _, item := range []struct {
		siteID, authorID, status, title string
	}{
		{console.ID, root.ID, "published", "Published one"},
		{console.ID, root.ID, "published", "Published two"},
		{console.ID, root.ID, "draft", "Draft"},
		{other.ID, admin.ID, "pending_review", "Waiting for review"},
	} {
		_, err := handle.Client.ContentItem.Create().
			SetSiteID(item.siteID).SetAuthorID(item.authorID).SetKind("article").
			SetStatus(item.status).SetTitle(item.title).SetSourceBody("body").Save(ctx)
		require.NoError(t, err)
	}

	for _, row := range []struct{ siteID, authorID, status string }{
		{console.ID, root.ID, "visible"},
		{console.ID, root.ID, "visible"},
		{other.ID, admin.ID, "pending_review"},
	} {
		_, err := handle.Client.Comment.Create().
			SetSiteID(row.siteID).SetAuthorID(row.authorID).
			SetTargetType("article").SetTargetID("whatever").
			SetBody("hello").SetStatus(row.status).Save(ctx)
		require.NoError(t, err)
	}

	_, err = handle.Client.ModerationReport.Create().
		SetSiteID(other.ID).SetReporterID(reader.ID).
		SetTargetType("comment").SetTargetID("target-1").
		SetReason("spam").SetStatus("open").Save(ctx)
	require.NoError(t, err)

	store := auditstore.New(handle.Client)
	now := time.Now().UTC()
	require.NoError(t, store.Record(ctx, audit.Entry{
		SiteID: console.ID, ActorID: root.ID, Action: "auth.login",
		TargetType: "user", TargetID: root.ID, At: now.Add(-time.Hour),
	}))
	require.NoError(t, store.Record(ctx, audit.Entry{
		SiteID: other.ID, ActorID: admin.ID, Action: "content.published",
		TargetType: "article", TargetID: "content-1", At: now.Add(-2 * time.Hour),
	}))
	require.NoError(t, store.Record(ctx, audit.Entry{
		SiteID: other.ID, Action: "auth.captcha.failed", Outcome: "failure",
		At: now.Add(-30 * time.Minute),
	}))
	// Outside the seven day window: the overview must not count it.
	require.NoError(t, store.Record(ctx, audit.Entry{
		SiteID: other.ID, Action: "auth.login", At: now.Add(-20 * 24 * time.Hour),
	}))

	cfg := config.Config{
		AppEnv: config.EnvTest, AuthJWTIssuer: "platform-cross-site-test",
		DefaultSiteID: console.ID,
	}
	issuer, _, err := auth.NewTokenIssuer(cfg)
	require.NoError(t, err)
	authService, err := auth.NewService(auth.ServiceConfig{
		Repository: authstore.New(handle.Client),
		Hasher: auth.NewArgon2idHasher(auth.Argon2Params{
			Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32,
		}),
		Tokens: issuer,
	})
	require.NoError(t, err)
	siteService, err := site.NewService(sitestore.New(handle.Client))
	require.NoError(t, err)

	consoleSite := site.Site{
		ID: console.ID, Slug: "main", Name: "Main", Domain: "main.local",
		DomainVerifiedAt: &verified,
	}
	otherSite := site.Site{
		ID: other.ID, Slug: "second", Name: "Second", Domain: "second.local",
	}
	resolver := &mapResolver{
		fallback: consoleSite,
		byHost:   map[string]site.Site{"second.local": otherSite},
	}

	platformService, err := platformadmin.NewService(platformadmin.ServiceConfig{
		Repository: sitestore.New(handle.Client),
		Accounts:   authService,
		Sessions:   authService,
		Tokens:     issuer,
		Domains:    siteService,
		Metrics:    platformstore.New(handle.Client),
		Directory:  platformstore.New(handle.Client),
		Trail:      store,
		Recorder:   store,
	})
	require.NoError(t, err)

	router := ginrouter.New(ginrouter.Dependencies{
		Config:       cfg,
		SiteResolver: resolver,
		AccessTokens: issuer,
		Memberships:  siteService,
		Platform: platformadmin.NewHandler(platformService, platformadmin.HandlerConfig{
			Principal: func(c *gin.Context) (string, string, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				return principal.UserID, principal.SiteID, ok
			},
			Site: middleware.SiteFrom,
		}),
	})

	rootTok, _, err := issuer.IssueAccess(auth.Principal{
		UserID: root.ID, SiteID: console.ID, Role: site.RolePlatformAdmin,
	})
	require.NoError(t, err)
	siteAdmTok, _, err := issuer.IssueAccess(auth.Principal{
		UserID: admin.ID, SiteID: other.ID, Role: site.RoleSiteAdmin,
	})
	require.NoError(t, err)

	return &crossSiteHarness{
		router:     router,
		client:     handle.Client,
		issuer:     issuer,
		consoleID:  console.ID,
		otherID:    other.ID,
		rootID:     root.ID,
		rootTok:    rootTok,
		siteAdmin:  admin.ID,
		siteAdmTok: siteAdmTok,
	}
}

func (h *crossSiteHarness) get(t *testing.T, path, host, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = host
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	h.router.ServeHTTP(recorder, req)
	return recorder
}

type overviewResponse struct {
	WindowDays int `json:"window_days"`
	Totals     struct {
		Sites            int `json:"sites"`
		DisabledSites    int `json:"disabled_sites"`
		UnverifiedSites  int `json:"unverified_sites"`
		Members          int `json:"members"`
		ActiveMembers    int `json:"active_members"`
		Admins           int `json:"admins"`
		Content          int `json:"content"`
		PublishedContent int `json:"published_content"`
		PendingContent   int `json:"pending_content"`
		Comments         int `json:"comments"`
		PendingComments  int `json:"pending_comments"`
		Accounts         int `json:"accounts"`
		VerifiedAccounts int `json:"verified_accounts"`
		TwoFactorChosen  int `json:"two_factor_accounts"`
	} `json:"totals"`
	Signals struct {
		OpenReports      int `json:"open_reports"`
		PendingComments  int `json:"pending_comments"`
		FailedActions    int `json:"failed_actions"`
		UnverifiedSites  int `json:"unverified_sites"`
		UnverifiedEmails int `json:"unverified_emails"`
		QuietSites       int `json:"quiet_sites"`
	} `json:"signals"`
	Sites []struct {
		ID                string `json:"id"`
		Name              string `json:"name"`
		DomainVerified    bool   `json:"domain_verified"`
		MemberCount       int    `json:"member_count"`
		ActiveMemberCount int    `json:"active_member_count"`
		AdminCount        int    `json:"admin_count"`
		ContentCount      int    `json:"content_count"`
		PublishedCount    int    `json:"published_content_count"`
		PendingCount      int    `json:"pending_content_count"`
		DraftCount        int    `json:"draft_count"`
		CommentCount      int    `json:"comment_count"`
		PendingComment    int    `json:"pending_comment_count"`
		OpenReportCount   int    `json:"open_report_count"`
		RecentActivity    int    `json:"recent_activity_count"`
		RecentFailures    int    `json:"recent_failure_count"`
	} `json:"sites"`
	RecentActivity []struct {
		SiteID   string `json:"site_id"`
		SiteName string `json:"site_name"`
		Action   string `json:"action"`
		Outcome  string `json:"outcome"`
	} `json:"recent_activity"`
}

type auditPageResponse struct {
	Items []struct {
		ID      string         `json:"id"`
		SiteID  string         `json:"site_id"`
		Action  string         `json:"action"`
		Outcome string         `json:"outcome"`
		Detail  map[string]any `json:"detail"`
	} `json:"items"`
	NextCursor string `json:"next_cursor"`
}

type accountPageResponse struct {
	Items []struct {
		UserID           string `json:"user_id"`
		DisplayName      string `json:"display_name"`
		Email            string `json:"email"`
		EmailVerified    bool   `json:"email_verified"`
		TwoFactorEnabled bool   `json:"two_factor_enabled"`
		Status           string `json:"status"`
		Memberships      []struct {
			SiteID   string `json:"site_id"`
			SiteName string `json:"site_name"`
			Role     string `json:"role"`
		} `json:"memberships"`
	} `json:"items"`
	NextCursor string `json:"next_cursor"`
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder, target any) {
	t.Helper()
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), target), recorder.Body.String())
}

func TestPlatformOverviewCountsTheDeployment(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := newCrossSiteHarness(t)

	recorder := h.get(t, "/api/v1/platform/overview?window_days=7", "main.local", h.rootTok)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	var body overviewResponse
	decodeBody(t, recorder, &body)
	require.Equal(t, 7, body.WindowDays)
	require.Equal(t, 2, body.Totals.Sites)
	require.Equal(t, 1, body.Totals.UnverifiedSites)
	require.Equal(t, 4, body.Totals.Members)
	require.Equal(t, 4, body.Totals.ActiveMembers)
	// root is a platform administrator, admin is a site administrator.
	require.Equal(t, 2, body.Totals.Admins)
	require.Equal(t, 4, body.Totals.Content)
	require.Equal(t, 2, body.Totals.PublishedContent)
	require.Equal(t, 1, body.Totals.PendingContent)
	require.Equal(t, 3, body.Totals.Comments)
	require.Equal(t, 1, body.Totals.PendingComments)
	require.Equal(t, 3, body.Totals.Accounts)
	require.Equal(t, 1, body.Totals.VerifiedAccounts)
	require.Equal(t, 1, body.Totals.TwoFactorChosen)

	require.Equal(t, 1, body.Signals.OpenReports)
	require.Equal(t, 1, body.Signals.PendingComments)
	require.Equal(t, 1, body.Signals.FailedActions)
	require.Equal(t, 1, body.Signals.UnverifiedSites)
	require.Equal(t, 2, body.Signals.UnverifiedEmails)

	require.Len(t, body.Sites, 2)
	second := body.Sites[1]
	require.Equal(t, h.otherID, second.ID)
	require.False(t, second.DomainVerified)
	require.Equal(t, 2, second.MemberCount)
	require.Equal(t, 1, second.ContentCount)
	require.Equal(t, 1, second.PendingCount)
	require.Equal(t, 1, second.PendingComment)
	require.Equal(t, 1, second.OpenReportCount)
	// Two rows of the second site are inside the window (the published article and the
	// refused human verification); the twenty day old login is not.
	require.Equal(t, 2, second.RecentActivity)
	require.Equal(t, 1, second.RecentFailures)

	// Recent rows cross the tenant boundary and carry their site label; the row written
	// twenty days ago is outside the window and is not part of the glance.
	require.Len(t, body.RecentActivity, 3)
	sites := map[string]bool{}
	for _, row := range body.RecentActivity {
		sites[row.SiteID] = true
	}
	require.True(t, sites[h.consoleID])
	require.True(t, sites[h.otherID])
}

func TestPlatformAuditLogsFiltersPaginatesAndAuditsItself(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := newCrossSiteHarness(t)
	ctx := context.Background()

	// Cross-site page: every site, newest first.
	all := h.get(t, "/api/v1/platform/audit-logs?limit=2", "main.local", h.rootTok)
	require.Equal(t, http.StatusOK, all.Code, all.Body.String())
	var firstPage auditPageResponse
	decodeBody(t, all, &firstPage)
	require.Len(t, firstPage.Items, 2)
	require.NotEmpty(t, firstPage.NextCursor)

	secondPageRecorder := h.get(
		t,
		"/api/v1/platform/audit-logs?limit=2&cursor="+firstPage.NextCursor,
		"main.local",
		h.rootTok,
	)
	require.Equal(t, http.StatusOK, secondPageRecorder.Code, secondPageRecorder.Body.String())
	var secondPage auditPageResponse
	decodeBody(t, secondPageRecorder, &secondPage)
	require.NotEmpty(t, secondPage.Items)

	seen := map[string]bool{}
	for _, item := range firstPage.Items {
		seen[item.ID] = true
	}
	for _, item := range secondPage.Items {
		require.False(t, seen[item.ID], "a page boundary must not repeat a row")
	}

	// The query wrote its own audit row on the actor's site.
	rows, err := h.client.AuditLog.Query().All(ctx)
	require.NoError(t, err)
	var queried int
	for _, row := range rows {
		if row.Action == "platform.audit.queried" {
			queried++
		}
	}
	require.GreaterOrEqual(t, queried, 2, "each cross-site query records itself")

	// Filtering by site stays inside that site.
	filtered := h.get(
		t,
		"/api/v1/platform/audit-logs?site_id="+h.otherID+"&action=auth.captcha.failed&outcome=failure",
		"main.local",
		h.rootTok,
	)
	require.Equal(t, http.StatusOK, filtered.Code, filtered.Body.String())
	var filteredPage auditPageResponse
	decodeBody(t, filtered, &filteredPage)
	require.Len(t, filteredPage.Items, 1)
	require.Equal(t, h.otherID, filteredPage.Items[0].SiteID)
	require.Equal(t, "auth.captcha.failed", filteredPage.Items[0].Action)
	require.Equal(t, "failure", filteredPage.Items[0].Outcome)

	// A malformed cursor and an inverted window are client errors, not empty pages.
	badCursor := h.get(t, "/api/v1/platform/audit-logs?cursor=not-a-cursor!", "main.local", h.rootTok)
	require.Equal(t, http.StatusBadRequest, badCursor.Code, badCursor.Body.String())
	badWindow := h.get(
		t,
		"/api/v1/platform/audit-logs?from=2026-03-10T00:00:00Z&to=2026-03-01T00:00:00Z",
		"main.local",
		h.rootTok,
	)
	require.Equal(t, http.StatusBadRequest, badWindow.Code, badWindow.Body.String())
}

func TestPlatformAccountsDirectoryLeaksNoSecrets(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := newCrossSiteHarness(t)

	recorder := h.get(t, "/api/v1/platform/users?limit=10", "main.local", h.rootTok)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	raw := recorder.Body.String()
	for _, forbidden := range []string{"password_hash", "secret", "access_token", "refresh_token"} {
		require.NotContains(t, raw, forbidden, "the directory must not carry %s", forbidden)
	}

	var body accountPageResponse
	decodeBody(t, recorder, &body)
	require.Len(t, body.Items, 3)

	byName := map[string]int{}
	for index, item := range body.Items {
		byName[item.DisplayName] = index
	}
	reader := body.Items[byName["Reader"]]
	require.Equal(t, "reader@example.com", reader.Email)
	require.True(t, reader.EmailVerified)
	require.True(t, reader.TwoFactorEnabled)
	require.Len(t, reader.Memberships, 2)
	roles := map[string]string{}
	for _, membership := range reader.Memberships {
		roles[membership.SiteID] = membership.Role
	}
	require.Equal(t, "member", roles[h.consoleID])
	require.Equal(t, "editor", roles[h.otherID])

	// A site filter lists that site's memberships only.
	scoped := h.get(t, "/api/v1/platform/users?site_id="+h.otherID, "main.local", h.rootTok)
	require.Equal(t, http.StatusOK, scoped.Code, scoped.Body.String())
	var scopedBody accountPageResponse
	decodeBody(t, scoped, &scopedBody)
	require.Len(t, scopedBody.Items, 2)
	for _, item := range scopedBody.Items {
		found := false
		for _, membership := range item.Memberships {
			if membership.SiteID == h.otherID {
				found = true
				require.Equal(t, "Second", membership.SiteName)
			}
		}
		require.True(t, found, "the filtered site is part of the memberships")
	}
	// The reader is a member of both sites, so the scoped page still shows both.
	for _, item := range scopedBody.Items {
		if item.DisplayName == "Reader" {
			require.Len(t, item.Memberships, 2)
		}
	}

	// Search matches the display name and the email address.
	search := h.get(t, "/api/v1/platform/users?q=reader@example", "main.local", h.rootTok)
	require.Equal(t, http.StatusOK, search.Code, search.Body.String())
	var searchBody accountPageResponse
	decodeBody(t, search, &searchBody)
	require.Len(t, searchBody.Items, 1)
	require.Equal(t, "Reader", searchBody.Items[0].DisplayName)
}

func TestCrossSiteEndpointsRefuseSiteAdmins(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := newCrossSiteHarness(t)

	for _, path := range []string{
		"/api/v1/platform/overview",
		"/api/v1/platform/audit-logs",
		"/api/v1/platform/users",
	} {
		recorder := h.get(t, path, "second.local", h.siteAdmTok)
		require.Equal(t, http.StatusForbidden, recorder.Code, "%s: %s", path, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), "platform_admin_required")
	}
}
