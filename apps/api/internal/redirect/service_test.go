package redirect

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

var testNow = time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)

// fakeRepo is an in memory Repository. It mirrors the store's uniqueness rule so the
// service conflict handling is exercised without a database.
type fakeRepo struct {
	mu    sync.Mutex
	rules []Redirect
	next  int
	hits  map[string]int
	finds int
}

func newFakeRepo(rules ...Redirect) *fakeRepo {
	repo := &fakeRepo{hits: make(map[string]int, len(rules))}
	repo.rules = append(repo.rules, rules...)
	return repo
}

func (f *fakeRepo) List(
	_ context.Context,
	siteID, query string,
	limit int,
	after page.Cursor,
) ([]Redirect, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	filtered := make([]Redirect, 0, len(f.rules))
	for _, rule := range f.rules {
		if rule.SiteID != siteID {
			continue
		}
		if query != "" && !containsFold(rule.FromPath, query) && !containsFold(rule.ToPath, query) {
			continue
		}
		filtered = append(filtered, rule)
	}
	sort.Slice(filtered, func(i, j int) bool {
		if !filtered[i].CreatedAt.Equal(filtered[j].CreatedAt) {
			return filtered[i].CreatedAt.After(filtered[j].CreatedAt)
		}
		return filtered[i].ID > filtered[j].ID
	})

	start := 0
	if !after.IsZero() {
		for index, rule := range filtered {
			if rule.ID == after.ID {
				start = index + 1
				break
			}
		}
	}
	filtered = filtered[start:]

	next := ""
	if limit > 0 && len(filtered) > limit {
		filtered = filtered[:limit]
		last := filtered[len(filtered)-1]
		next = page.Cursor{Key: last.CreatedAt.UTC().Format(time.RFC3339Nano), ID: last.ID}.Encode()
	}
	if filtered == nil {
		filtered = []Redirect{}
	}
	return filtered, next, nil
}

func (f *fakeRepo) FindByPath(_ context.Context, siteID, fromPath string) (Redirect, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.finds++
	for _, rule := range f.rules {
		if rule.SiteID == siteID && rule.FromPath == fromPath {
			return rule, nil
		}
	}
	return Redirect{}, ErrNotFound
}

func (f *fakeRepo) FindByID(_ context.Context, siteID, redirectID string) (Redirect, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	for _, rule := range f.rules {
		if rule.SiteID == siteID && rule.ID == redirectID {
			return rule, nil
		}
	}
	return Redirect{}, ErrNotFound
}

func (f *fakeRepo) Insert(_ context.Context, rule Redirect) (Redirect, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	for _, existing := range f.rules {
		if existing.SiteID == rule.SiteID && existing.FromPath == rule.FromPath {
			return Redirect{}, ErrConflict
		}
	}
	if rule.ID == "" {
		f.next++
		rule.ID = fmt.Sprintf("rule_%d", f.next)
	}
	f.rules = append(f.rules, rule)
	return rule, nil
}

func (f *fakeRepo) Update(_ context.Context, rule Redirect) (Redirect, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	index := -1
	for position, existing := range f.rules {
		if existing.ID == rule.ID && existing.SiteID == rule.SiteID {
			index = position
			continue
		}
		if existing.SiteID == rule.SiteID && existing.FromPath == rule.FromPath {
			return Redirect{}, ErrConflict
		}
	}
	if index < 0 {
		return Redirect{}, ErrNotFound
	}
	f.rules[index] = rule
	return rule, nil
}

func (f *fakeRepo) Delete(_ context.Context, siteID, redirectID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	for index, rule := range f.rules {
		if rule.SiteID == siteID && rule.ID == redirectID {
			f.rules = append(f.rules[:index], f.rules[index+1:]...)
			return nil
		}
	}
	return ErrNotFound
}

func (f *fakeRepo) IncrementHitCount(_ context.Context, _, redirectID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.hits[redirectID]++
	return nil
}

func (f *fakeRepo) hitCount(redirectID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.hits[redirectID]
}

// locateResult is one content address the fake locator knows.
type locateResult struct {
	contentID string
	slug      string
	title     string
	ok        bool
}

// fakeLocator is a scripted content locator.
type fakeLocator struct {
	mu      sync.Mutex
	results map[string]locateResult
	errs    []error
	calls   int
}

func newFakeLocator() *fakeLocator {
	return &fakeLocator{results: map[string]locateResult{}}
}

func (l *fakeLocator) add(kind, key, contentID, slug, title string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.results[kind+":"+key] = locateResult{contentID: contentID, slug: slug, title: title, ok: true}
}

func (l *fakeLocator) Locate(_ context.Context, _, kind, key string) (string, string, string, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.calls++
	if len(l.errs) > 0 {
		err := l.errs[0]
		l.errs = l.errs[1:]
		if err != nil {
			return "", "", "", false, err
		}
	}
	result, ok := l.results[kind+":"+key]
	if !ok {
		return "", "", "", false, nil
	}
	return result.contentID, result.slug, result.title, result.ok, nil
}

func (l *fakeLocator) callCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.calls
}

func containsFold(value, query string) bool {
	return len(query) <= len(value) && indexFold(value, query) >= 0
}

func indexFold(value, query string) int {
	loweredValue := []rune(lowerASCII(value))
	loweredQuery := []rune(lowerASCII(query))
	if len(loweredQuery) > len(loweredValue) {
		return -1
	}
	for start := 0; start+len(loweredQuery) <= len(loweredValue); start++ {
		match := true
		for offset := range loweredQuery {
			if loweredValue[start+offset] != loweredQuery[offset] {
				match = false
				break
			}
		}
		if match {
			return start
		}
	}
	return -1
}

func lowerASCII(value string) string {
	out := make([]rune, 0, len(value))
	for _, r := range value {
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		out = append(out, r)
	}
	return string(out)
}

func newTestService(t *testing.T, repo Repository, locator ContentLocator) *Service {
	t.Helper()

	service, err := NewService(ServiceConfig{
		Repository: repo,
		Locator:    locator,
		Now:        func() time.Time { return testNow },
	})
	require.NoError(t, err)
	// Run the detached hit counter inline so an assertion right after Resolve is
	// deterministic instead of racing the goroutine.
	service.launch = func(task func()) { task() }
	return service
}

func siteActor(role site.Role) site.Member {
	return site.Member{
		UserID: "user_1",
		SiteID: "site_1",
		Role:   role,
		Status: site.MemberStatusActive,
	}
}

func TestNewServiceRequiresRepository(t *testing.T) {
	_, err := NewService(ServiceConfig{})
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestResolveMatchesExactNormalisedPathAndCountsHit(t *testing.T) {
	repo := newFakeRepo(Redirect{
		ID: "rule_1", SiteID: "site_1", FromPath: "/a/old", ToPath: "/a/new",
		StatusCode: 301, Source: SourceManual,
	})
	service := newTestService(t, repo, nil)

	rule, found, err := service.Resolve(context.Background(), "site_1", "/a/old/?utm=1")
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "rule_1", rule.ID)
	require.Equal(t, 1, repo.hitCount("rule_1"))

	// A different path is not a prefix match.
	_, found, err = service.Resolve(context.Background(), "site_1", "/a/old/deeper")
	require.NoError(t, err)
	require.False(t, found)
	require.Equal(t, 1, repo.hitCount("rule_1"))

	// Another tenant's identical path does not resolve.
	_, found, err = service.Resolve(context.Background(), "site_2", "/a/old")
	require.NoError(t, err)
	require.False(t, found)
}

func TestResolvePropagatesRepositoryFailure(t *testing.T) {
	repo := &failingRepo{err: errors.New("boom")}
	service := newTestService(t, repo, nil)

	_, _, err := service.Resolve(context.Background(), "site_1", "/a/old")
	require.Error(t, err)
}

// failingRepo fails every read, which is enough to prove the service does not swallow
// a store error.
type failingRepo struct {
	fakeRepo
	err error
}

func (f *failingRepo) FindByPath(context.Context, string, string) (Redirect, error) {
	return Redirect{}, f.err
}

func TestCreateNormalisesAndRejectsDuplicate(t *testing.T) {
	repo := newFakeRepo()
	service := newTestService(t, repo, nil)
	admin := siteActor(site.RoleSiteAdmin)

	created, err := service.Create(context.Background(), admin, "site_1", Input{
		FromPath: "/a/old/",
		ToPath:   " /a/new ",
	})
	require.NoError(t, err)
	require.Equal(t, "/a/old", created.FromPath)
	require.Equal(t, "/a/new", created.ToPath)
	require.Equal(t, 301, created.StatusCode)
	require.Equal(t, SourceManual, created.Source)
	require.NotEmpty(t, created.ID)

	_, err = service.Create(context.Background(), admin, "site_1", Input{
		FromPath: "/a/old?x=1", ToPath: "/a/other",
	})
	require.ErrorIs(t, err, ErrConflict)
}

func TestUpdateRejectsMovingOntoAnotherRule(t *testing.T) {
	first := Redirect{ID: "rule_1", SiteID: "site_1", FromPath: "/a/one", ToPath: "/a/x", StatusCode: 301, Source: SourceManual}
	second := Redirect{ID: "rule_2", SiteID: "site_1", FromPath: "/a/two", ToPath: "/a/y", StatusCode: 301, Source: SourceManual}
	repo := newFakeRepo(first, second)
	service := newTestService(t, repo, nil)

	fromPath := "/a/two"
	_, err := service.Update(context.Background(), siteActor(site.RoleSiteAdmin), "site_1", "rule_1", PatchInput{
		FromPath: &fromPath,
	})
	require.ErrorIs(t, err, ErrConflict)

	_, err = service.Update(context.Background(), siteActor(site.RoleSiteAdmin), "site_1", "missing", PatchInput{})
	require.ErrorIs(t, err, ErrNotFound)
}

func TestDeleteReportsMissingRule(t *testing.T) {
	repo := newFakeRepo()
	service := newTestService(t, repo, nil)

	err := service.Delete(context.Background(), siteActor(site.RoleSiteAdmin), "site_1", "missing")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestManagementRequiresManageSite(t *testing.T) {
	repo := newFakeRepo()
	service := newTestService(t, repo, nil)
	ctx := context.Background()

	_, err := service.List(ctx, siteActor(site.RoleMember), "site_1", "", 10, page.Cursor{})
	require.ErrorIs(t, err, ErrPermissionDenied)

	_, err = service.List(ctx, siteActor(site.RoleEditor), "site_1", "", 10, page.Cursor{})
	require.ErrorIs(t, err, ErrPermissionDenied)

	_, err = service.List(ctx, siteMemberForSite(site.RoleSiteAdmin, "site_2"), "site_1", "", 10, page.Cursor{})
	require.ErrorIs(t, err, ErrCrossSite)

	_, err = service.List(ctx, site.Member{}, "site_1", "", 10, page.Cursor{})
	require.ErrorIs(t, err, ErrPermissionDenied)

	_, err = service.Create(ctx, siteActor(site.RoleMember), "site_1", Input{FromPath: "/a/old", ToPath: "/a/new"})
	require.ErrorIs(t, err, ErrPermissionDenied)

	err = service.Delete(ctx, siteActor(site.RoleMember), "site_1", "rule_1")
	require.ErrorIs(t, err, ErrPermissionDenied)

	// A platform administrator outranks the site administrator.
	_, err = service.List(ctx, siteActor(site.RolePlatformAdmin), "site_1", "", 10, page.Cursor{})
	require.NoError(t, err)
}

func siteMemberForSite(role site.Role, siteID string) site.Member {
	member := siteActor(role)
	member.SiteID = siteID
	return member
}

func TestListAppliesSearchAndPagination(t *testing.T) {
	repo := newFakeRepo(
		Redirect{ID: "rule_1", SiteID: "site_1", FromPath: "/a/old", ToPath: "/a/new", StatusCode: 301, Source: SourceManual, CreatedAt: testNow},
		Redirect{ID: "rule_2", SiteID: "site_1", FromPath: "/p/old", ToPath: "/p/new", StatusCode: 302, Source: SourceManual, CreatedAt: testNow.Add(time.Minute)},
		Redirect{ID: "rule_3", SiteID: "site_2", FromPath: "/a/old", ToPath: "/a/new", StatusCode: 301, Source: SourceManual, CreatedAt: testNow},
	)
	service := newTestService(t, repo, nil)
	admin := siteActor(site.RoleSiteAdmin)

	first, err := service.List(context.Background(), admin, "site_1", "", 1, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, first.Items, 1)
	require.Equal(t, "rule_2", first.Items[0].ID, "newest first")
	require.True(t, first.HasMore)
	require.NotEmpty(t, first.NextCursor)

	after, err := page.Decode(first.NextCursor)
	require.NoError(t, err)
	second, err := service.List(context.Background(), admin, "site_1", "", 1, after)
	require.NoError(t, err)
	require.Len(t, second.Items, 1)
	require.Equal(t, "rule_1", second.Items[0].ID)
	require.False(t, second.HasMore)

	found, err := service.List(context.Background(), admin, "site_1", "P/OLD", 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, found.Items, 1)
	require.Equal(t, "rule_2", found.Items[0].ID)
}

func TestRecordSlugChangeInsertsAutomaticRule(t *testing.T) {
	repo := newFakeRepo()
	service := newTestService(t, repo, nil)

	err := service.RecordSlugChange(context.Background(), "site_1", "/a/old-slug", "/a/new-slug")
	require.NoError(t, err)

	rule, err := repo.FindByPath(context.Background(), "site_1", "/a/old-slug")
	require.NoError(t, err)
	require.Equal(t, "/a/new-slug", rule.ToPath)
	require.Equal(t, 301, rule.StatusCode)
	require.Equal(t, SourceSlugChange, rule.Source)
}

func TestRecordSlugChangeInvalidatesTheResolveCache(t *testing.T) {
	repo := newFakeRepo()
	service := newTestService(t, repo, nil)
	var purged []string
	service.SetOnRulesChanged(func(siteID string) { purged = append(purged, siteID) })

	require.NoError(t, service.RecordSlugChange(context.Background(), "site_1", "/a/old", "/a/new"))
	require.Contains(t, purged, "site_1",
		"an automatic rule must purge the handler cache, or the old path keeps 404ing for one TTL")
}

func TestRecordSlugChangeIsNoOpForEmptyOrIdenticalPaths(t *testing.T) {
	repo := newFakeRepo()
	service := newTestService(t, repo, nil)
	ctx := context.Background()

	require.NoError(t, service.RecordSlugChange(ctx, "site_1", "", "/a/new"))
	require.NoError(t, service.RecordSlugChange(ctx, "site_1", "/a/old", ""))
	require.NoError(t, service.RecordSlugChange(ctx, "site_1", "/a/same", "/a/same"))
	require.NoError(t, service.RecordSlugChange(ctx, "site_1", "/a/same/", "/a/same"))
	require.NoError(t, service.RecordSlugChange(ctx, "", "/a/old", "/a/new"))

	require.Empty(t, repo.rules, "nothing to redirect means no row")
}

func TestRecordSlugChangeReplacesThePreviousAutomaticRule(t *testing.T) {
	existing := Redirect{
		ID: "rule_1", SiteID: "site_1", FromPath: "/a/old", ToPath: "/a/intermediate",
		StatusCode: 302, Source: SourceSlugChange, CreatedAt: testNow, UpdatedAt: testNow,
	}
	repo := newFakeRepo(existing)
	service := newTestService(t, repo, nil)

	require.NoError(t, service.RecordSlugChange(context.Background(), "site_1", "/a/old", "/a/final"))

	rule, err := repo.FindByPath(context.Background(), "site_1", "/a/old")
	require.NoError(t, err)
	require.Equal(t, "/a/final", rule.ToPath)
	require.Equal(t, 301, rule.StatusCode)
	require.Equal(t, SourceSlugChange, rule.Source)
	require.Len(t, repo.rules, 1, "the automatic rule is replaced, not duplicated")
	require.Equal(t, testNow, rule.UpdatedAt)
}

func TestRecordSlugChangeLeavesManualRuleAlone(t *testing.T) {
	manual := Redirect{
		ID: "rule_1", SiteID: "site_1", FromPath: "/a/old", ToPath: "/a/pinned",
		StatusCode: 308, Source: SourceManual, CreatedAt: testNow, UpdatedAt: testNow,
	}
	repo := newFakeRepo(manual)
	service := newTestService(t, repo, nil)

	require.NoError(t, service.RecordSlugChange(context.Background(), "site_1", "/a/old", "/a/new"))

	rule, err := repo.FindByPath(context.Background(), "site_1", "/a/old")
	require.NoError(t, err)
	require.Equal(t, "/a/pinned", rule.ToPath, "an operator pinned destination wins")
	require.Equal(t, 308, rule.StatusCode)
	require.Equal(t, SourceManual, rule.Source)
}

func TestRecordSlugChangeRetriesAfterLosingTheInsertRace(t *testing.T) {
	repo := &racingRepo{}
	service := newTestService(t, repo, nil)

	require.NoError(t, service.RecordSlugChange(context.Background(), "site_1", "/a/old", "/a/new"))
	require.Equal(t, 2, repo.findCalls, "the second lookup sees the row the other writer created")

	rule, err := repo.FindByPath(context.Background(), "site_1", "/a/old")
	require.NoError(t, err)
	require.Equal(t, "/a/new", rule.ToPath)
	require.Equal(t, SourceSlugChange, rule.Source)
}

// racingRepo loses the insert race once: the first lookup misses, the insert reports the
// concurrent row, and the second lookup finds it.
type racingRepo struct {
	fakeRepo
	findCalls int
}

func (r *racingRepo) FindByPath(ctx context.Context, siteID, fromPath string) (Redirect, error) {
	r.findCalls++
	if r.findCalls == 1 {
		return Redirect{}, ErrNotFound
	}
	return r.fakeRepo.FindByPath(ctx, siteID, fromPath)
}

func (r *racingRepo) Insert(_ context.Context, rule Redirect) (Redirect, error) {
	rule.ID = "rule_race"
	r.fakeRepo.rules = append(r.fakeRepo.rules, rule)
	return Redirect{}, ErrConflict
}

func TestRecordSlugChangePropagatesStoreFailure(t *testing.T) {
	repo := &failingRepo{err: errors.New("database down")}
	service := newTestService(t, repo, nil)

	err := service.RecordSlugChange(context.Background(), "site_1", "/a/old", "/a/new")
	require.Error(t, err)
}

func TestResolvePathPrefersRedirectTableOverContent(t *testing.T) {
	repo := newFakeRepo(Redirect{
		ID: "rule_1", SiteID: "site_1", FromPath: "/a/old", ToPath: "/a/new",
		StatusCode: 301, Source: SourceManual,
	})
	locator := newFakeLocator()
	locator.add(LocateKindArticle, "old", "content_1", "old", "Old")
	service := newTestService(t, repo, locator)

	resolution, err := service.ResolvePath(context.Background(), "site_1", "/a/old")
	require.NoError(t, err)
	require.Equal(t, KindRedirect, resolution.Kind)
	require.Equal(t, "/a/new", resolution.CanonicalPath)
	require.Equal(t, 301, resolution.Status)
	require.Equal(t, 0, locator.callCount(), "the content lookup is skipped when a rule owns the path")
}

func TestResolvePathReportsContentByIDAsMoved(t *testing.T) {
	for _, tc := range []struct {
		kind, prefix, key, slug string
	}{
		{kind: LocateKindArticle, prefix: "/a/", key: "content_1", slug: "hello-world"},
		{kind: LocateKindPost, prefix: "/p/", key: "content_2", slug: "release-notes"},
	} {
		repo := newFakeRepo()
		locator := newFakeLocator()
		locator.add(tc.kind, tc.key, tc.key, tc.slug, "Title")
		service := newTestService(t, repo, locator)

		resolution, err := service.ResolvePath(context.Background(), "site_1", tc.prefix+tc.key)
		require.NoError(t, err)
		require.Equal(t, KindContent, resolution.Kind)
		require.Equal(t, 301, resolution.Status)
		require.Equal(t, tc.prefix+tc.slug, resolution.CanonicalPath)
		require.Equal(t, tc.key, resolution.ContentID)
		require.Equal(t, tc.slug, resolution.Slug)
		require.Equal(t, "Title", resolution.Title)
	}
}

func TestResolvePathServesSlugFormDirectly(t *testing.T) {
	repo := newFakeRepo()
	locator := newFakeLocator()
	locator.add(LocateKindArticle, "hello-world", "content_1", "hello-world", "Hello")
	service := newTestService(t, repo, locator)

	resolution, err := service.ResolvePath(context.Background(), "site_1", "/a/hello-world?utm=1")
	require.NoError(t, err)
	require.Equal(t, KindContent, resolution.Kind)
	require.Equal(t, 200, resolution.Status)
	require.Equal(t, "/a/hello-world", resolution.CanonicalPath)
}

func TestResolvePathWithoutSlugKeepsIDPathAtTwoHundred(t *testing.T) {
	repo := newFakeRepo()
	locator := newFakeLocator()
	locator.add(LocateKindArticle, "content_1", "content_1", "", "Legacy")
	service := newTestService(t, repo, locator)

	resolution, err := service.ResolvePath(context.Background(), "site_1", "/a/content_1")
	require.NoError(t, err)
	require.Equal(t, KindContent, resolution.Kind)
	require.Equal(t, 200, resolution.Status, "redirecting to itself would be a loop")
	require.Equal(t, "/a/content_1", resolution.CanonicalPath)
}

func TestResolvePathReportsMissing(t *testing.T) {
	repo := newFakeRepo()
	locator := newFakeLocator()
	service := newTestService(t, repo, locator)

	for _, path := range []string{"/a/gone", "/p/gone", "/about", "/"} {
		resolution, err := service.ResolvePath(context.Background(), "site_1", path)
		require.NoError(t, err)
		require.Equal(t, KindMissing, resolution.Kind, "path %q", path)
		require.Equal(t, 404, resolution.Status)
		require.Equal(t, path, resolution.CanonicalPath)
	}

	require.Equal(t, 2, locator.callCount(), "only the two content prefixed paths reach the locator")
}

func TestResolvePathPropagatesLocatorFailure(t *testing.T) {
	repo := newFakeRepo()
	locator := newFakeLocator()
	locator.errs = []error{errors.New("content store down")}
	service := newTestService(t, repo, locator)

	_, err := service.ResolvePath(context.Background(), "site_1", "/a/foo")
	require.Error(t, err)
}

func TestResolvePathWithoutLocatorIsMissing(t *testing.T) {
	service := newTestService(t, newFakeRepo(), nil)

	resolution, err := service.ResolvePath(context.Background(), "site_1", "/a/foo")
	require.NoError(t, err)
	require.Equal(t, KindMissing, resolution.Kind)

	// The composition root attaches the content service after both exist.
	locator := newFakeLocator()
	locator.add(LocateKindArticle, "hello", "content_1", "hello", "Hello")
	service.SetLocator(locator)

	resolution, err = service.ResolvePath(context.Background(), "site_1", "/a/hello")
	require.NoError(t, err)
	require.Equal(t, KindContent, resolution.Kind)
	require.Equal(t, "content_1", resolution.ContentID)
}

func TestResolvePathRejectsBadPath(t *testing.T) {
	service := newTestService(t, newFakeRepo(), nil)

	_, err := service.ResolvePath(context.Background(), "site_1", "   ")
	require.ErrorIs(t, err, ErrInvalidInput)
}
