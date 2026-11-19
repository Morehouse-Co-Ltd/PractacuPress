package platformadmin

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/site"
)

type fakeRepo struct {
	sites     []site.Site
	members   map[string]site.Member
	documents map[string]string
	audits    []site.AuditEntry
	deleted   []string
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		members:   make(map[string]site.Member),
		documents: make(map[string]string),
	}
}

// verifiedSite builds the console site every creation test starts from: a platform
// administrator may only add sites once its own hostname is proven.
func verifiedSite(id, slug, name, domain string) site.Site {
	at := time.Now().UTC()
	return site.Site{ID: id, Slug: slug, Name: name, Domain: domain, DomainVerifiedAt: &at}
}

func memberKey(siteID, userID string) string { return siteID + "/" + userID }

func (f *fakeRepo) CreateSite(_ context.Context, in SiteRecord) (site.Site, error) {
	created := site.Site{
		ID:             "site-" + in.Slug,
		Slug:           in.Slug,
		Name:           in.Name,
		Description:    in.Description,
		Domain:         in.Domain,
		VisibilityMode: in.VisibilityMode,
		PublishMode:    in.PublishMode,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	if in.DomainToken != "" {
		created.DomainVerificationToken = in.DomainToken
	}
	f.sites = append(f.sites, created)
	f.documents[created.ID] = string(in.DesignDocument)
	return created, nil
}

func (f *fakeRepo) DeleteSite(_ context.Context, siteID string) error {
	f.deleted = append(f.deleted, siteID)
	for index, candidate := range f.sites {
		if candidate.ID == siteID {
			f.sites = append(f.sites[:index], f.sites[index+1:]...)
			break
		}
	}
	delete(f.documents, siteID)
	return nil
}

func (f *fakeRepo) FindSite(_ context.Context, siteID string) (site.Site, error) {
	for _, candidate := range f.sites {
		if candidate.ID == siteID {
			return candidate, nil
		}
	}
	return site.Site{}, site.ErrNotFound
}

func (f *fakeRepo) ListSites(_ context.Context, limit int) ([]site.Site, error) {
	if limit > 0 && len(f.sites) > limit {
		return f.sites[:limit], nil
	}
	return f.sites, nil
}

func (f *fakeRepo) SlugTaken(_ context.Context, slug string) (bool, error) {
	for _, candidate := range f.sites {
		if candidate.Slug == slug {
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeRepo) DomainTaken(_ context.Context, domain string) (bool, error) {
	for _, candidate := range f.sites {
		if candidate.Domain == domain {
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeRepo) FindMember(_ context.Context, siteID, userID string) (site.Member, error) {
	if member, ok := f.members[memberKey(siteID, userID)]; ok {
		return member, nil
	}
	return site.Member{}, site.ErrMemberNotFound
}

func (f *fakeRepo) CountMembers(_ context.Context, siteID string) (int, error) {
	count := 0
	for _, member := range f.members {
		if member.SiteID == siteID {
			count++
		}
	}
	return count, nil
}

func (f *fakeRepo) CountAdmins(_ context.Context, siteID string) (int, error) {
	count := 0
	for _, member := range f.members {
		if member.SiteID == siteID && member.IsActive() && member.Role.AtLeast(site.RoleSiteAdmin) {
			count++
		}
	}
	return count, nil
}

func (f *fakeRepo) EnsureMember(
	_ context.Context,
	siteID, userID string,
	role site.Role,
	audit site.AuditEntry,
) error {
	f.members[memberKey(siteID, userID)] = site.Member{
		SiteID: siteID,
		UserID: userID,
		Role:   role,
		Status: site.MemberStatusActive,
	}
	f.audits = append(f.audits, audit)
	return nil
}

func (f *fakeRepo) RecordAudit(_ context.Context, audit site.AuditEntry) error {
	f.audits = append(f.audits, audit)
	return nil
}

func (f *fakeRepo) addMember(siteID, userID string, role site.Role, status string) {
	f.members[memberKey(siteID, userID)] = site.Member{
		SiteID: siteID, UserID: userID, Role: role, Status: status,
	}
}

type fakeAccounts struct {
	calls       []auth.CreateMemberInput
	err         error
	id          string
	onProvision func(siteID, userID string)
}

func (f *fakeAccounts) ProvisionSiteOwner(
	_ context.Context,
	siteID string,
	in auth.CreateMemberInput,
) (auth.UserView, error) {
	f.calls = append(f.calls, in)
	if f.err != nil {
		return auth.UserView{}, f.err
	}
	id := f.id
	if id == "" {
		id = "owner-1"
	}
	if f.onProvision != nil {
		f.onProvision(siteID, id)
	}
	return auth.UserView{ID: id, DisplayName: in.DisplayName, Status: auth.AccountStatusActive}, nil
}

type fakeSessions struct {
	calls   int
	session auth.Session
	err     error
}

func (f *fakeSessions) IssueSwitchSession(
	_ context.Context,
	_, _ string,
	_ auth.ClientMeta,
) (auth.Session, error) {
	f.calls++
	if f.err != nil {
		return auth.Session{}, f.err
	}
	if f.session.AccessToken == "" {
		f.session.AccessToken = "access-token"
	}
	return f.session, nil
}

type fakeDomains struct {
	calls  int
	siteID string
	userID string
	status site.DomainStatus
	err    error
}

func (f *fakeDomains) VerifyDomainForPlatform(
	_ context.Context,
	siteID, userID string,
) (site.DomainStatus, error) {
	f.calls++
	f.siteID = siteID
	f.userID = userID
	if f.err != nil {
		return site.DomainStatus{}, f.err
	}
	if f.status.Domain == "" {
		f.status = site.DomainStatus{Domain: "b.example", Verified: true, RecordType: "TXT"}
	}
	return f.status, nil
}

func newTestService(t *testing.T, repo Repository, accounts AccountProvisioner) (*Service, *auth.TokenIssuer) {
	t.Helper()
	issuer, _, err := auth.NewTokenIssuer(config.Config{
		AppEnv:        config.EnvTest,
		AuthJWTIssuer: "platform-test",
	})
	require.NoError(t, err)
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Accounts:   accounts,
		Sessions:   &fakeSessions{},
		Tokens:     issuer,
		Domains:    &fakeDomains{},
		Metrics:    &fakeMetrics{},
		Directory:  &fakeDirectory{},
		Trail:      &fakeTrail{},
		Recorder:   &fakeRecorder{},
	})
	require.NoError(t, err)
	return service, issuer
}

func TestListSitesRequiresPlatformAdmin(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "admin", site.RolePlatformAdmin, site.MemberStatusActive)
	repo.addMember("site-a", "editor", site.RoleEditor, site.MemberStatusActive)
	service, _ := newTestService(t, repo, &fakeAccounts{})

	_, err := service.ListSites(context.Background(), "site-a", "editor")
	require.ErrorIs(t, err, ErrPermissionDenied)

	summaries, err := service.ListSites(context.Background(), "site-a", "admin")
	require.NoError(t, err)
	require.Len(t, summaries, 1)
	require.Equal(t, "A", summaries[0].Site.Name)
}

func TestCreateSiteCreatesDefaultDesignAndOwner(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{verifiedSite("site-a", "a", "A", "console.example")}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	accounts := &fakeAccounts{id: "owner-9"}
	accounts.onProvision = func(siteID string, _ string) {
		repo.addMember(siteID, "owner-9", site.RoleSiteAdmin, site.MemberStatusActive)
	}
	service, _ := newTestService(t, repo, accounts)

	summary, owner, err := service.CreateSite(context.Background(), "site-a", "root", CreateSiteInput{
		Name:           " Journal ",
		Slug:           "Journal",
		Description:    "a site",
		Domain:         "Press.Example.com.",
		VisibilityMode: site.VisibilityMembersOnly,
		Owner: OwnerInput{
			Email:       "Owner@Example.com",
			DisplayName: "Owner",
			Password:    "correct horse battery",
		},
	})
	require.NoError(t, err)
	require.Equal(t, "Journal", summary.Site.Name)
	require.Equal(t, "journal", summary.Site.Slug)
	require.Equal(t, "press.example.com", summary.Site.Domain)
	require.NotEmpty(t, summary.Site.DomainVerificationToken)
	require.Equal(t, DefaultDesignDocument, repo.documents[summary.Site.ID])
	require.Equal(t, site.VisibilityMembersOnly, summary.Site.VisibilityMode)
	require.Equal(t, site.PublishModeReview, summary.Site.PublishMode, "default publish mode")
	require.Equal(t, "owner-9", owner.ID)
	require.Len(t, accounts.calls, 1)
	require.Equal(t, "owner@example.com", accounts.calls[0].Email)
	require.Equal(t, "correct horse battery", accounts.calls[0].Password)
	require.Equal(t, site.RoleSiteAdmin, accounts.calls[0].Role)
	require.Equal(t, 1, summary.MemberCount)
	require.Len(t, repo.audits, 1)
	require.Equal(t, "platform.site.created", repo.audits[0].Action)
}

func TestCreateSiteRejectsDuplicateSlugOrDomain(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{verifiedSite("site-a", "taken", "A", "taken.example")}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, _ := newTestService(t, repo, &fakeAccounts{})

	base := CreateSiteInput{
		Name: "New", Domain: "new.example",
		Owner: OwnerInput{Email: "owner@example.com", DisplayName: "Owner", Password: "correct horse battery"},
	}
	duplicateSlug := base
	duplicateSlug.Slug = "taken"
	_, _, err := service.CreateSite(context.Background(), "site-a", "root", duplicateSlug)
	require.ErrorIs(t, err, ErrSlugTaken)

	duplicateDomain := base
	duplicateDomain.Slug = "new"
	duplicateDomain.Domain = "taken.example"
	_, _, err = service.CreateSite(context.Background(), "site-a", "root", duplicateDomain)
	require.ErrorIs(t, err, ErrDomainTaken)
}

func TestCreateSiteRejectsInvalidInput(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{verifiedSite("site-a", "a", "A", "console.example")}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, _ := newTestService(t, repo, &fakeAccounts{})

	valid := CreateSiteInput{
		Name: "New", Slug: "new", Domain: "new.example",
		Owner: OwnerInput{Email: "owner@example.com", DisplayName: "Owner", Password: "correct horse battery"},
	}
	cases := map[string]func(*CreateSiteInput){
		"name required":    func(in *CreateSiteInput) { in.Name = " " },
		"slug invalid":     func(in *CreateSiteInput) { in.Slug = "Not A Slug" },
		"domain required":  func(in *CreateSiteInput) { in.Domain = "" },
		"domain malformed": func(in *CreateSiteInput) { in.Domain = "https://example.com" },
		"weak password":    func(in *CreateSiteInput) { in.Owner.Password = "Aa1!Aa1!Aa1" }, // 11 runes
		"email malformed":  func(in *CreateSiteInput) { in.Owner.Email = "not-an-email" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			in := valid
			mutate(&in)
			_, _, err := service.CreateSite(context.Background(), "site-a", "root", in)
			require.ErrorIs(t, err, ErrInvalidInput)
			require.Len(t, repo.sites, 1, "only the console site remains")
		})
	}
}

func TestCreateSiteRemovesSiteWhenOwnerCannotBeCreated(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{verifiedSite("site-a", "a", "A", "console.example")}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	accounts := &fakeAccounts{err: auth.ErrIdentityExists}
	service, _ := newTestService(t, repo, accounts)

	_, _, err := service.CreateSite(context.Background(), "site-a", "root", CreateSiteInput{
		Name: "New", Slug: "new", Domain: "new.example",
		Owner: OwnerInput{Email: "owner@example.com", DisplayName: "Owner", Password: "correct horse battery"},
	})
	require.ErrorIs(t, err, auth.ErrIdentityExists)
	require.Len(t, repo.sites, 1, "the half created site must be removed again")
	require.Len(t, repo.deleted, 1)
}

func TestCreateSiteRequiresConsoleSiteDomain(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-a", Slug: "a", Name: "A"}}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, _ := newTestService(t, repo, &fakeAccounts{})

	_, _, err := service.CreateSite(context.Background(), "site-a", "root", CreateSiteInput{
		Name: "New", Slug: "new", Domain: "new.example",
		Owner: OwnerInput{Email: "owner@example.com", DisplayName: "Owner", Password: "correct horse battery"},
	})
	require.ErrorIs(t, err, ErrConsoleSiteNeedsDomain)
	require.Len(t, repo.sites, 1)
}

func TestEnterSiteIssuesHandoffForVerifiedTarget(t *testing.T) {
	verified := time.Now().UTC()
	repo := newFakeRepo()
	repo.sites = []site.Site{
		{ID: "site-a", Slug: "a", Name: "A"},
		{ID: "site-b", Slug: "b", Name: "B", Domain: "b.example", DomainVerifiedAt: &verified},
	}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, issuer := newTestService(t, repo, &fakeAccounts{})

	entry, err := service.EnterSite(context.Background(), "site-a", "root", "site-b")
	require.NoError(t, err)
	require.True(t, entry.Switchable)
	require.NotEmpty(t, entry.SwitchToken)
	require.Equal(t, site.RolePlatformAdmin, entry.Role)

	// Entering grants the operator a live membership on the target site.
	member, err := repo.FindMember(context.Background(), "site-b", "root")
	require.NoError(t, err)
	require.Equal(t, site.RolePlatformAdmin, member.Role)

	userID, siteID, err := issuer.VerifySiteSwitch(entry.SwitchToken)
	require.NoError(t, err)
	require.Equal(t, "root", userID)
	require.Equal(t, "site-b", siteID)
}

func TestEnterSiteReportsUnverifiedDomain(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{
		{ID: "site-a", Slug: "a", Name: "A"},
		{ID: "site-b", Slug: "b", Name: "B", Domain: "b.example"},
	}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, _ := newTestService(t, repo, &fakeAccounts{})

	entry, err := service.EnterSite(context.Background(), "site-a", "root", "site-b")
	require.NoError(t, err)
	require.False(t, entry.Switchable)
	require.Equal(t, EntryReasonDomainUnverified, entry.Reason)
	require.Empty(t, entry.SwitchToken)
}

func TestEnterSiteAllowsTargetOwnerAndRefusesEditor(t *testing.T) {
	verified := time.Now().UTC()
	repo := newFakeRepo()
	repo.sites = []site.Site{
		{ID: "site-a", Slug: "a", Name: "A"},
		{ID: "site-b", Slug: "b", Name: "B", Domain: "b.example", DomainVerifiedAt: &verified},
	}
	repo.addMember("site-a", "owner", site.RoleMember, site.MemberStatusActive)
	repo.addMember("site-a", "editor", site.RoleMember, site.MemberStatusActive)
	repo.addMember("site-b", "owner", site.RoleSiteAdmin, site.MemberStatusActive)
	repo.addMember("site-b", "editor", site.RoleEditor, site.MemberStatusActive)
	service, _ := newTestService(t, repo, &fakeAccounts{})

	entry, err := service.EnterSite(context.Background(), "site-a", "owner", "site-b")
	require.NoError(t, err)
	require.True(t, entry.Switchable)
	require.Equal(t, site.RoleSiteAdmin, entry.Role)

	_, err = service.EnterSite(context.Background(), "site-a", "editor", "site-b")
	require.ErrorIs(t, err, ErrPermissionDenied)
}

func TestClaimSwitchRequiresTheTargetOrigin(t *testing.T) {
	verified := time.Now().UTC()
	repo := newFakeRepo()
	repo.sites = []site.Site{
		{ID: "site-a", Slug: "a", Name: "A"},
		{ID: "site-b", Slug: "b", Name: "B", Domain: "b.example", DomainVerifiedAt: &verified},
	}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	repo.addMember("site-b", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	service, issuer := newTestService(t, repo, &fakeAccounts{})

	token, _, err := issuer.IssueSiteSwitch("root", "site-b")
	require.NoError(t, err)

	_, _, err = service.ClaimSwitch(context.Background(), "site-a", token, auth.ClientMeta{})
	require.ErrorIs(t, err, ErrPermissionDenied, "a token for site B must not mint a session on site A")

	session, claimedSite, err := service.ClaimSwitch(context.Background(), "site-b", token, auth.ClientMeta{})
	require.NoError(t, err)
	require.Equal(t, "access-token", session.AccessToken)
	require.Equal(t, "site-b", claimedSite.ID)
}

func TestClaimSwitchRejectsInactiveMembershipAndForgedToken(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{{ID: "site-b", Slug: "b", Name: "B", Domain: "b.example"}}
	repo.addMember("site-b", "root", site.RolePlatformAdmin, site.MemberStatusSuspended)
	service, issuer := newTestService(t, repo, &fakeAccounts{})

	token, _, err := issuer.IssueSiteSwitch("root", "site-b")
	require.NoError(t, err)
	_, _, err = service.ClaimSwitch(context.Background(), "site-b", token, auth.ClientMeta{})
	require.ErrorIs(t, err, ErrPermissionDenied)

	_, _, err = service.ClaimSwitch(context.Background(), "site-b", "not-a-token", auth.ClientMeta{})
	require.ErrorIs(t, err, ErrSwitchTokenInvalid)
}

func TestSwitchTokenIsNotAnAccessToken(t *testing.T) {
	_, issuer := newTestService(t, newFakeRepo(), &fakeAccounts{})
	token, _, err := issuer.IssueSiteSwitch("root", "site-b")
	require.NoError(t, err)
	_, err = issuer.VerifyAccess(token)
	require.ErrorIs(t, err, auth.ErrInvalidToken)
}

func TestCreateSiteRejectsNonPlatformAdmin(t *testing.T) {
	repo := newFakeRepo()
	repo.addMember("site-a", "admin", site.RoleSiteAdmin, site.MemberStatusActive)
	service, _ := newTestService(t, repo, &fakeAccounts{})

	_, _, err := service.CreateSite(context.Background(), "site-a", "admin", CreateSiteInput{
		Name: "New", Slug: "new", Domain: "new.example",
		Owner: OwnerInput{Email: "owner@example.com", DisplayName: "Owner", Password: "correct horse battery"},
	})
	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Empty(t, repo.sites)
}

func TestGetSiteAllowsPlatformAdminAndTargetOwner(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{
		{ID: "site-a", Slug: "a", Name: "A"},
		{ID: "site-b", Slug: "b", Name: "B"},
	}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	repo.addMember("site-a", "owner-b", site.RoleMember, site.MemberStatusActive)
	repo.addMember("site-b", "owner-b", site.RoleSiteAdmin, site.MemberStatusActive)
	service, _ := newTestService(t, repo, &fakeAccounts{})

	detail, err := service.GetSite(context.Background(), "site-a", "root", "site-b")
	require.NoError(t, err)
	require.Equal(t, "B", detail.Site.Site.Name)
	require.Equal(t, site.RolePlatformAdmin, detail.Role)

	detail, err = service.GetSite(context.Background(), "site-a", "owner-b", "site-b")
	require.NoError(t, err)
	require.Equal(t, "B", detail.Site.Site.Name)
	require.Equal(t, site.RoleSiteAdmin, detail.Role)

	_, err = service.GetSite(context.Background(), "site-a", "owner-b", "site-a")
	require.ErrorIs(t, err, ErrPermissionDenied)
}

func TestVerifyDomainRequiresAuthorityAndDelegates(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{
		{ID: "site-a", Slug: "a", Name: "A"},
		{ID: "site-b", Slug: "b", Name: "B", Domain: "b.example", DomainVerificationToken: "token"},
	}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	repo.addMember("site-a", "outsider", site.RoleMember, site.MemberStatusActive)
	domains := &fakeDomains{}
	issuer, _, err := auth.NewTokenIssuer(config.Config{AppEnv: config.EnvTest, AuthJWTIssuer: "platform-test"})
	require.NoError(t, err)
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Accounts:   &fakeAccounts{},
		Sessions:   &fakeSessions{},
		Tokens:     issuer,
		Domains:    domains,
		Metrics:    &fakeMetrics{},
		Directory:  &fakeDirectory{},
		Trail:      &fakeTrail{},
		Recorder:   &fakeRecorder{},
	})
	require.NoError(t, err)

	_, err = service.VerifyDomain(context.Background(), "site-a", "outsider", "site-b")
	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Zero(t, domains.calls)

	status, err := service.VerifyDomain(context.Background(), "site-a", "root", "site-b")
	require.NoError(t, err)
	require.True(t, status.Verified)
	require.Equal(t, 1, domains.calls)
	require.Equal(t, "site-b", domains.siteID)
	require.Equal(t, "root", domains.userID)
}

func TestVerifyDomainPropagatesDNSFailure(t *testing.T) {
	repo := newFakeRepo()
	repo.sites = []site.Site{
		{ID: "site-a", Slug: "a", Name: "A"},
		{ID: "site-b", Slug: "b", Name: "B", Domain: "b.example"},
	}
	repo.addMember("site-a", "root", site.RolePlatformAdmin, site.MemberStatusActive)
	domains := &fakeDomains{err: site.ErrDomainVerificationFailed}
	issuer, _, err := auth.NewTokenIssuer(config.Config{AppEnv: config.EnvTest, AuthJWTIssuer: "platform-test"})
	require.NoError(t, err)
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Accounts:   &fakeAccounts{},
		Sessions:   &fakeSessions{},
		Tokens:     issuer,
		Domains:    domains,
		Metrics:    &fakeMetrics{},
		Directory:  &fakeDirectory{},
		Trail:      &fakeTrail{},
		Recorder:   &fakeRecorder{},
	})
	require.NoError(t, err)

	_, err = service.VerifyDomain(context.Background(), "site-a", "root", "site-b")
	require.ErrorIs(t, err, site.ErrDomainVerificationFailed)
}

func TestServiceRequiresDependencies(t *testing.T) {
	_, err := NewService(ServiceConfig{})
	require.Error(t, err)
}
