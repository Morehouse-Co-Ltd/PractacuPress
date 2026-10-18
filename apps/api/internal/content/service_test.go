package content

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

type fakeRepo struct {
	items  map[string]Content
	audits []site.AuditEntry
	seq    int
}

func newFakeRepo() *fakeRepo { return &fakeRepo{items: make(map[string]Content)} }

func (f *fakeRepo) Insert(_ context.Context, item Content, audit site.AuditEntry) (Content, error) {
	f.seq++
	item.ID = fmt.Sprintf("c%d", f.seq)
	f.items[item.ID] = item
	f.audits = append(f.audits, audit)
	return item, nil
}

func (f *fakeRepo) SaveDraft(_ context.Context, item Content, audit site.AuditEntry) (Content, error) {
	if _, ok := f.items[item.ID]; !ok {
		return Content{}, ErrNotFound
	}
	f.items[item.ID] = item
	f.audits = append(f.audits, audit)
	return item, nil
}

func (f *fakeRepo) FindByID(_ context.Context, siteID, contentID string) (Content, error) {
	item, ok := f.items[contentID]
	if !ok || item.SiteID != siteID {
		return Content{}, ErrNotFound
	}
	return item, nil
}

func (f *fakeRepo) Transition(_ context.Context, item Content, from Status, audit site.AuditEntry) (Content, error) {
	stored, ok := f.items[item.ID]
	if !ok || stored.SiteID != item.SiteID {
		return Content{}, ErrNotFound
	}
	if stored.Status != from {
		return Content{}, ErrInvalidTransition
	}
	f.items[item.ID] = item
	f.audits = append(f.audits, audit)
	return item, nil
}

type fakeSanitizer struct {
	err     error
	html    string
	version string
	calls   int
}

func (f *fakeSanitizer) Sanitize(context.Context, SourceFormat, string) (Sanitized, error) {
	f.calls++
	if f.err != nil {
		return Sanitized{}, f.err
	}
	return Sanitized{HTML: f.html, PolicyVersion: f.version}, nil
}

func okSanitizer() *fakeSanitizer {
	return &fakeSanitizer{html: "<p>safe</p>", version: "policy-1"}
}

func newService(t *testing.T, repo Repository, sanitizer Sanitizer, mode site.PublishMode) *Service {
	t.Helper()
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Sanitizer:  sanitizer,
		PublishMode: func(context.Context, string) (site.PublishMode, error) {
			return mode, nil
		},
		Now: func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)
	return service
}

func sampleDraft() DraftInput {
	return DraftInput{
		Title:        "Hello World",
		SourceFormat: FormatMarkdown,
		SourceBody:   "<script>bad()</script># Hello",
	}
}

func TestCreateDraftSanitizesAndStoresHTML(t *testing.T) {
	repo := newFakeRepo()
	sanitizer := okSanitizer()
	service := newService(t, repo, sanitizer, site.PublishModeReview)
	author := actor("author", site.RoleMember)

	item, err := service.CreateDraft(context.Background(), author, KindArticle, sampleDraft())
	require.NoError(t, err)

	require.Equal(t, StatusDraft, item.Status)
	require.Equal(t, "<p>safe</p>", item.RenderedHTML, "rendered HTML must come from the sanitizer")
	require.Equal(t, "policy-1", item.PolicyVersion)
	require.Equal(t, "hello-world", item.Slug, "slug is derived when absent")
	require.Equal(t, "<script>bad()</script># Hello", item.SourceBody, "the source is preserved")
	require.Equal(t, 1, sanitizer.calls)
	require.Len(t, repo.audits, 1)
	require.Equal(t, "content.created", repo.audits[0].Action)
}

// TestCreateDraftFailsClosedWhenSanitizerUnavailable is the core safety property:
// an outage must hold content, not publish it unchecked.
func TestCreateDraftFailsClosedWhenSanitizerUnavailable(t *testing.T) {
	repo := newFakeRepo()
	sanitizer := &fakeSanitizer{err: errors.New("grpc unavailable")}
	service := newService(t, repo, sanitizer, site.PublishModeOpen)

	item, err := service.CreateDraft(context.Background(), actor("author", site.RoleMember), KindArticle, sampleDraft())

	require.ErrorIs(t, err, ErrSecurityUnavailable)
	require.Equal(t, StatusPendingSecurityCheck, item.Status)
	require.Empty(t, item.RenderedHTML)
	require.Empty(t, item.PolicyVersion)
	require.NotNil(t, repo.items[item.ID], "the author's work must not be lost")
}

func TestPublishRequiresSanitizedRevision(t *testing.T) {
	repo := newFakeRepo()
	repo.items["held"] = Content{
		ID: "held", SiteID: "s1", AuthorID: "author", Kind: KindArticle,
		Status: StatusPendingReview, Title: "T", SourceFormat: FormatMarkdown,
		SourceBody: "x",
	}
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)

	_, err := service.Apply(context.Background(), actor("mod", site.RoleEditor), "held", ActionPublish, "")
	require.ErrorIs(t, err, ErrSecurityUnavailable,
		"publishing content without a sanitized revision must be refused")
}

func TestSubmitThenPublishFlow(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	author := actor("author", site.RoleMember)
	editor := actor("mod", site.RoleEditor)
	ctx := context.Background()

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)

	submitted, err := service.Apply(ctx, author, item.ID, ActionSubmit, "")
	require.NoError(t, err)
	require.Equal(t, StatusPendingReview, submitted.Status)

	published, err := service.Apply(ctx, editor, item.ID, ActionPublish, "looks good")
	require.NoError(t, err)
	require.Equal(t, StatusPublished, published.Status)
	require.NotNil(t, published.PublishedAt)

	actions := repo.audits[len(repo.audits)-1]
	require.Equal(t, "content.publish", actions.Action)
	require.Equal(t, "looks good", actions.Detail["reason"])
}

func TestMemberCannotPublishDirectlyInReviewMode(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)

	_, err = service.Apply(ctx, author, item.ID, ActionPublish, "")
	require.ErrorIs(t, err, ErrReviewRequired)
	require.Equal(t, StatusDraft, repo.items[item.ID].Status)
}

func TestOpenModeMemberPublishesOwnDraft(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeOpen)
	author := actor("author", site.RoleMember)

	item, err := service.CreateDraft(context.Background(), author, KindPost, sampleDraft())
	require.NoError(t, err)

	published, err := service.Apply(context.Background(), author, item.ID, ActionPublish, "")
	require.NoError(t, err)
	require.Equal(t, StatusPublished, published.Status)
}

func TestPublishIsIdempotentOnlyOnce(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeOpen)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item, err := service.CreateDraft(ctx, author, KindPost, sampleDraft())
	require.NoError(t, err)
	_, err = service.Apply(ctx, author, item.ID, ActionPublish, "")
	require.NoError(t, err)

	_, err = service.Apply(ctx, author, item.ID, ActionPublish, "")
	require.ErrorIs(t, err, ErrInvalidTransition)
}

func TestUpdateDraftRejectsPublishedContent(t *testing.T) {
	repo := newFakeRepo()
	repo.items["c1"] = Content{
		ID: "c1", SiteID: "s1", AuthorID: "author", Kind: KindArticle,
		Status: StatusPublished, RenderedHTML: "<p>x</p>", PolicyVersion: "p1",
	}
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)

	_, err := service.UpdateDraft(context.Background(), actor("author", site.RoleMember), "c1", sampleDraft())
	require.ErrorIs(t, err, ErrInvalidTransition)
}

func TestUpdateDraftRejectsOtherAuthors(t *testing.T) {
	repo := newFakeRepo()
	repo.items["c1"] = Content{
		ID: "c1", SiteID: "s1", AuthorID: "author", Kind: KindArticle, Status: StatusDraft,
	}
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)

	_, err := service.UpdateDraft(context.Background(), actor("stranger", site.RoleMember), "c1", sampleDraft())
	require.ErrorIs(t, err, ErrPermissionDenied)

	// An editor may fix someone else's draft.
	_, err = service.UpdateDraft(context.Background(), actor("mod", site.RoleEditor), "c1", sampleDraft())
	require.NoError(t, err)
}

func TestGetHidesUnpublishedFromStrangers(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)

	_, err = service.Get(ctx, actor("stranger", site.RoleMember), item.ID)
	require.ErrorIs(t, err, ErrNotFound)

	found, err := service.Get(ctx, author, item.ID)
	require.NoError(t, err)
	require.Equal(t, item.ID, found.ID)

	found, err = service.Get(ctx, actor("mod", site.RoleEditor), item.ID)
	require.NoError(t, err)
	require.Equal(t, item.ID, found.ID)
}

func TestRetrySecurityCheckRecoversHeldItem(t *testing.T) {
	repo := newFakeRepo()
	sanitizer := &fakeSanitizer{err: errors.New("down")}
	service := newService(t, repo, sanitizer, site.PublishModeReview)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.ErrorIs(t, err, ErrSecurityUnavailable)
	require.Equal(t, StatusPendingSecurityCheck, item.Status)

	// The service recovers once the sanitizer does.
	sanitizer.err = nil
	sanitizer.html = "<p>clean</p>"
	sanitizer.version = "policy-2"

	recovered, err := service.RetrySecurityCheck(ctx, author, item.ID)
	require.NoError(t, err)
	require.Equal(t, StatusDraft, recovered.Status)
	require.Equal(t, "<p>clean</p>", recovered.RenderedHTML)
}

func TestRetrySecurityCheckRefusesHealthyItems(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)

	_, err = service.RetrySecurityCheck(ctx, author, item.ID)
	require.ErrorIs(t, err, ErrInvalidTransition)
}

func TestConcurrentTransitionIsRejectedByStaleStatus(t *testing.T) {
	repo := newFakeRepo()
	repo.items["c1"] = Content{
		ID: "c1", SiteID: "s1", AuthorID: "author", Kind: KindArticle,
		Status: StatusPendingReview, RenderedHTML: "<p>x</p>", PolicyVersion: "p1",
	}
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	editor := actor("mod", site.RoleEditor)
	ctx := context.Background()

	_, err := service.Apply(ctx, editor, "c1", ActionPublish, "")
	require.NoError(t, err)

	// A second moderator already saw pending_review; the guard rejects the stale move.
	_, err = service.Apply(ctx, editor, "c1", ActionReject, "")
	require.ErrorIs(t, err, ErrInvalidTransition)
}

func TestNewServiceRequiresDependencies(t *testing.T) {
	_, err := NewService(ServiceConfig{})
	require.Error(t, err)

	_, err = NewService(ServiceConfig{Repository: newFakeRepo()})
	require.Error(t, err, "a sanitizer is mandatory: content must never bypass it")
}

func TestDefaultPolicyIsReview(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(ServiceConfig{Repository: repo, Sanitizer: okSanitizer()})
	require.NoError(t, err)

	mode, err := service.publishMode(context.Background(), "s1")
	require.NoError(t, err)
	require.Equal(t, site.PublishModeReview, mode)
}
