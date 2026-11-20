package content

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
)

type fakeRepo struct {
	items  map[string]Content
	audits []site.AuditEntry
	// revisions records every snapshot the service decided to write.
	revisions []Revision
	seq       int
	// lastFilter records the filter the service handed down, so tests can assert on
	// the narrowing the store would receive.
	lastFilter ListFilter
	// lastPopularFilter records the leaderboard query the service handed down.
	lastPopularFilter PopularFilter
}

func newFakeRepo() *fakeRepo { return &fakeRepo{items: make(map[string]Content)} }

// addRevision stores a snapshot with a stable id, like the store does.
func (f *fakeRepo) addRevision(revision Revision) Revision {
	revision.ID = fmt.Sprintf("rev%d", len(f.revisions)+1)
	f.revisions = append(f.revisions, revision)
	return revision
}

func (f *fakeRepo) Insert(_ context.Context, item Content, audit site.AuditEntry) (Content, error) {
	f.seq++
	item.ID = fmt.Sprintf("c%d", f.seq)
	item.Revision = 1
	f.items[item.ID] = item
	f.audits = append(f.audits, audit)
	f.addRevision(item.Snapshot(1, item.AuthorID, RevisionCreated, item.CreatedAt))
	return item, nil
}

func (f *fakeRepo) SaveDraft(_ context.Context, item Content, audit site.AuditEntry) (Content, error) {
	stored, ok := f.items[item.ID]
	if !ok {
		return Content{}, ErrNotFound
	}
	if stored.Revision != item.Revision {
		return Content{}, ErrConflict
	}
	item.Revision++
	f.items[item.ID] = item
	f.audits = append(f.audits, audit)
	f.addRevision(item.Snapshot(item.Revision, audit.ActorID, RevisionUpdated, item.UpdatedAt))
	return item, nil
}

// FindByID mirrors the store: a trashed item is invisible to every read path.
func (f *fakeRepo) FindByID(_ context.Context, siteID, contentID string) (Content, error) {
	item, ok := f.items[contentID]
	if !ok || item.SiteID != siteID || item.IsTrashed() {
		return Content{}, ErrNotFound
	}
	return item, nil
}

// FindByIDIncludingTrashed is the recycle bin lookup the lifecycle actions use.
func (f *fakeRepo) FindByIDIncludingTrashed(_ context.Context, siteID, contentID string) (Content, error) {
	item, ok := f.items[contentID]
	if !ok || item.SiteID != siteID {
		return Content{}, ErrNotFound
	}
	return item, nil
}

// Trash stamps the marker once, like the conditional store update: a repeated delete
// must not refresh deleted_at.
func (f *fakeRepo) Trash(_ context.Context, item Content, audit site.AuditEntry) (Content, error) {
	stored, ok := f.items[item.ID]
	if !ok || stored.SiteID != item.SiteID {
		return Content{}, ErrNotFound
	}
	if !stored.IsTrashed() {
		stored.DeletedAt = item.DeletedAt
		stored.UpdatedAt = item.UpdatedAt
		f.items[item.ID] = stored
		f.audits = append(f.audits, audit)
	}
	return stored, nil
}

func (f *fakeRepo) Undelete(_ context.Context, item Content, audit site.AuditEntry) (Content, error) {
	stored, ok := f.items[item.ID]
	if !ok || stored.SiteID != item.SiteID {
		return Content{}, ErrNotFound
	}
	if stored.IsTrashed() {
		stored.DeletedAt = nil
		stored.UpdatedAt = item.UpdatedAt
		f.items[item.ID] = stored
		f.audits = append(f.audits, audit)
	}
	return stored, nil
}

// Purge removes the item and its history in one step, like the store transaction.
func (f *fakeRepo) Purge(_ context.Context, siteID, contentID string, audit site.AuditEntry) error {
	stored, ok := f.items[contentID]
	if !ok || stored.SiteID != siteID {
		return ErrNotFound
	}
	if !stored.IsTrashed() {
		return ErrInvalidTransition
	}
	delete(f.items, contentID)
	kept := make([]Revision, 0, len(f.revisions))
	for _, revision := range f.revisions {
		if revision.ContentID != contentID {
			kept = append(kept, revision)
		}
	}
	f.revisions = kept
	f.audits = append(f.audits, audit)
	return nil
}

// PurgeExpired mirrors the retention sweep: only rows trashed before the cutoff go.
func (f *fakeRepo) PurgeExpired(_ context.Context, before time.Time, limit int) (int, error) {
	removed := 0
	for id, item := range f.items {
		if limit > 0 && removed >= limit {
			break
		}
		if item.DeletedAt == nil || item.DeletedAt.After(before) {
			continue
		}
		delete(f.items, id)
		removed++
	}
	return removed, nil
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

func (f *fakeRepo) ListRevisions(_ context.Context, siteID, contentID string, limit int) ([]Revision, error) {
	out := make([]Revision, 0)
	for i := len(f.revisions) - 1; i >= 0; i-- {
		revision := f.revisions[i]
		if revision.SiteID != siteID || revision.ContentID != contentID {
			continue
		}
		out = append(out, revision)
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func (f *fakeRepo) FindRevision(_ context.Context, siteID, contentID, revisionID string) (Revision, error) {
	for _, revision := range f.revisions {
		if revision.ID == revisionID && revision.SiteID == siteID && revision.ContentID == contentID {
			return revision, nil
		}
	}
	return Revision{}, ErrNotFound
}

func (f *fakeRepo) RestoreRevision(
	_ context.Context,
	item Content,
	backup Revision,
	audit site.AuditEntry,
) (Content, error) {
	stored, ok := f.items[item.ID]
	if !ok {
		return Content{}, ErrNotFound
	}
	if stored.Revision != item.Revision {
		return Content{}, ErrConflict
	}
	backup.Version = item.Revision + 1
	backup = f.addRevision(backup)
	item.Revision += 2
	f.items[item.ID] = item
	f.audits = append(f.audits, audit)
	f.addRevision(item.Snapshot(item.Revision, audit.ActorID, RevisionRollback, item.UpdatedAt))
	return item, nil
}

func (f *fakeRepo) List(_ context.Context, filter ListFilter) ([]Content, error) {
	f.lastFilter = filter
	out := make([]Content, 0, len(f.items))
	for _, item := range f.items {
		if item.SiteID != filter.SiteID {
			continue
		}
		// The bin listing and the ordinary listing never overlap.
		if filter.Trashed != item.IsTrashed() {
			continue
		}
		if filter.Kind != "" && item.Kind != filter.Kind {
			continue
		}
		if filter.AuthorID != "" && item.AuthorID != filter.AuthorID {
			continue
		}
		if len(filter.Statuses) > 0 {
			allowed := false
			for _, status := range filter.Statuses {
				if item.Status == status {
					allowed = true
					break
				}
			}
			if !allowed {
				continue
			}
		}
		if len(filter.AccessModes) > 0 {
			allowed := false
			mode := item.AccessMode
			if mode == "" {
				// A zero value predates the access control field and means public.
				mode = AccessPublic
			}
			for _, filterMode := range filter.AccessModes {
				if mode == filterMode {
					allowed = true
					break
				}
			}
			if !allowed {
				continue
			}
		}
		out = append(out, item)
	}
	if filter.Limit > 0 && len(out) > filter.Limit {
		out = out[:filter.Limit]
	}
	return out, nil
}

func (f *fakeRepo) Search(_ context.Context, filter SearchFilter) (SearchPage, error) {
	out := make([]Content, 0)
	term := strings.ToLower(filter.Term)
	for _, item := range f.items {
		if item.SiteID != filter.SiteID || item.Status != StatusPublished {
			continue
		}
		if item.IsTrashed() {
			continue
		}
		if item.AccessMode != "" && item.AccessMode != AccessPublic {
			continue
		}
		if filter.Kind != "" && item.Kind != filter.Kind {
			continue
		}
		if filter.CategoryID != "" && item.CategoryID != filter.CategoryID {
			continue
		}
		if filter.AuthorID != "" && item.AuthorID != filter.AuthorID {
			continue
		}
		haystack := strings.ToLower(item.Title + " " + item.Summary + " " + item.SourceBody)
		if term != "" && !strings.Contains(haystack, term) {
			continue
		}
		out = append(out, item)
	}
	total := len(out)
	if filter.Limit > 0 && len(out) > filter.Limit {
		out = out[:filter.Limit]
	}
	return SearchPage{Items: out, Total: total}, nil
}

// DueSchedules implements the scheduler read used by ProcessScheduledPublishing.
func (f *fakeRepo) DueSchedules(_ context.Context, now time.Time, limit int) ([]Content, error) {
	out := make([]Content, 0)
	for _, item := range f.items {
		if item.Status != StatusDraft || item.PublishAt == nil || item.PublishAt.After(now) {
			continue
		}
		if item.IsTrashed() {
			continue
		}
		out = append(out, item)
	}
	return out, nil
}

// RecordScheduleFailure mirrors the stored attempt counter and optional cancel.
func (f *fakeRepo) RecordScheduleFailure(
	_ context.Context,
	siteID, contentID string,
	attempts int,
	cancel bool,
	audit site.AuditEntry,
) error {
	item, ok := f.items[contentID]
	if !ok || item.SiteID != siteID {
		return ErrNotFound
	}
	item.PublishAttempts = attempts
	if cancel {
		item.PublishAt = nil
	}
	f.items[contentID] = item
	f.audits = append(f.audits, audit)
	return nil
}

// IncrementViewCount mirrors the store's single incrementing update: only a
// published item of the same site is counted.
func (f *fakeRepo) IncrementViewCount(_ context.Context, siteID, contentID string) error {
	item, ok := f.items[contentID]
	if !ok || item.SiteID != siteID || item.Status != StatusPublished || item.IsTrashed() {
		return nil
	}
	item.ViewCount++
	f.items[contentID] = item
	return nil
}

// Popular mirrors the store's candidate query: published public items inside the
// horizon, ordered by raw view count and then by publication date.
func (f *fakeRepo) Popular(_ context.Context, filter PopularFilter) ([]Content, error) {
	f.lastPopularFilter = filter
	out := make([]Content, 0, len(f.items))
	for _, item := range f.items {
		if item.SiteID != filter.SiteID || item.Status != StatusPublished {
			continue
		}
		if item.IsTrashed() {
			continue
		}
		mode := item.AccessMode
		if mode == "" {
			mode = AccessPublic
		}
		if mode != AccessPublic {
			continue
		}
		if filter.Kind != "" && item.Kind != filter.Kind {
			continue
		}
		if filter.CategoryID != "" && item.CategoryID != filter.CategoryID {
			continue
		}
		if filter.Tag != "" {
			found := false
			for _, tag := range item.Tags {
				if tag == filter.Tag {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		if !filter.PublishedSince.IsZero() {
			if item.PublishedAt == nil || item.PublishedAt.Before(filter.PublishedSince) {
				continue
			}
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ViewCount != out[j].ViewCount {
			return out[i].ViewCount > out[j].ViewCount
		}
		return publishedTime(out[i]).After(publishedTime(out[j]))
	})
	if filter.Limit > 0 && len(out) > filter.Limit {
		out = out[:filter.Limit]
	}
	return out, nil
}

type fakeSanitizer struct {
	err        error
	html       string
	version    string
	calls      int
	lastFormat SourceFormat
	lastSource string
}

func (f *fakeSanitizer) Sanitize(_ context.Context, format SourceFormat, source string) (Sanitized, error) {
	f.calls++
	f.lastFormat = format
	f.lastSource = source
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
	sanitizer := &fakeSanitizer{err: errors.New("sanitizer unavailable")}
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

func TestUpdateDraftRevisesPublishedContentAndKeepsHistory(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)

	// Publishing is a status move, not a save, so it adds no snapshot.
	published, err := service.Apply(ctx, actor("mod", site.RoleEditor), item.ID, ActionPublish, "")
	require.NoError(t, err)
	require.Equal(t, StatusPublished, published.Status)

	in := sampleDraft()
	in.SourceBody = "# Revised"
	revised, err := service.UpdateDraft(ctx, author, item.ID, in)
	require.NoError(t, err)
	require.Equal(t, StatusPublished, revised.Status, "a revision must keep the item live")
	require.Equal(t, "# Revised", revised.SourceBody)
	require.Equal(t, published.Revision+1, revised.Revision)

	history, err := service.ListRevisions(ctx, author, item.ID)
	require.NoError(t, err)
	require.Len(t, history, 2, "create and revision each leave a version")
	require.Equal(t, RevisionUpdated, history[0].Action)
	require.Equal(t, "# Revised", history[0].SourceBody)
	require.Equal(t, RevisionCreated, history[1].Action)
}

func TestPublishedRevisionFailsClosedWhenSanitizerIsUnavailable(t *testing.T) {
	repo := newFakeRepo()
	repo.items["c1"] = Content{
		ID: "c1", SiteID: "s1", AuthorID: "author", Kind: KindArticle,
		Status: StatusPublished, SourceBody: "old", RenderedHTML: "<p>old</p>",
		PolicyVersion: "p1", Revision: 2,
	}
	sanitizer := &fakeSanitizer{err: errors.New("sanitizer unavailable")}
	service := newService(t, repo, sanitizer, site.PublishModeOpen)

	_, err := service.UpdateDraft(context.Background(), actor("author", site.RoleMember), "c1", sampleDraft())
	require.ErrorIs(t, err, ErrSecurityUnavailable)

	stored := repo.items["c1"]
	require.Equal(t, StatusPublished, stored.Status, "a failed revision must not unpublish live content")
	require.Equal(t, "old", stored.SourceBody)
	require.Len(t, repo.revisions, 0)
}

func TestUpdateDraftRejectsPendingReviewContent(t *testing.T) {
	repo := newFakeRepo()
	repo.items["c1"] = Content{
		ID: "c1", SiteID: "s1", AuthorID: "author", Kind: KindArticle,
		Status: StatusPendingReview,
	}
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)

	_, err := service.UpdateDraft(context.Background(), actor("author", site.RoleMember), "c1", sampleDraft())
	require.ErrorIs(t, err, ErrInvalidTransition)
}

func TestRevisionHistoryIsHiddenFromStrangers(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)

	_, err = service.ListRevisions(ctx, actor("stranger", site.RoleMember), item.ID)
	require.ErrorIs(t, err, ErrNotFound)

	history, err := service.ListRevisions(ctx, actor("mod", site.RoleEditor), item.ID)
	require.NoError(t, err)
	require.Len(t, history, 1)
}

func TestRestoreRevisionBacksUpCurrentStateAndKeepsStatus(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)
	first := item.SourceBody

	in := sampleDraft()
	in.SourceBody = "# Second"
	_, err = service.UpdateDraft(ctx, author, item.ID, in)
	require.NoError(t, err)

	history, err := service.ListRevisions(ctx, author, item.ID)
	require.NoError(t, err)
	// history[0] is the second save, history[1] the original create.
	restored, err := service.RestoreRevision(ctx, author, item.ID, history[1].ID)
	require.NoError(t, err)
	require.Equal(t, first, restored.SourceBody)
	require.Equal(t, StatusDraft, restored.Status)

	history, err = service.ListRevisions(ctx, author, item.ID)
	require.NoError(t, err)
	require.Equal(t, RevisionRollback, history[0].Action)
	require.Equal(t, RevisionRollbackBackup, history[1].Action, "the pre-rollback state must be backed up")
	require.Equal(t, "# Second", history[1].SourceBody)
}

func TestRestoreRevisionIsAuthorOrEditorOnly(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)
	history, err := service.ListRevisions(ctx, author, item.ID)
	require.NoError(t, err)

	_, err = service.RestoreRevision(ctx, actor("stranger", site.RoleMember), item.ID, history[0].ID)
	require.ErrorIs(t, err, ErrNotFound)
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

// TestListHidesUnpublishedFromReaders is the listing side of the same rule the read
// endpoint enforces: a member must not discover another author's draft through a list.
func TestListHidesUnpublishedFromReaders(t *testing.T) {
	repo := newFakeRepo()
	repo.items["published"] = Content{ID: "published", SiteID: "s1", AuthorID: "someone",
		Kind: KindArticle, Status: StatusPublished}
	repo.items["draft"] = Content{ID: "draft", SiteID: "s1", AuthorID: "someone",
		Kind: KindArticle, Status: StatusDraft}

	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	ctx := context.Background()

	visible, err := service.List(ctx, actor("reader", site.RoleMember), KindArticle, 10, ListFilter{})
	require.NoError(t, err)
	require.Len(t, visible, 1)
	require.Equal(t, "published", visible[0].ID)

	moderated, err := service.List(ctx, actor("mod", site.RoleEditor), KindArticle, 10, ListFilter{})
	require.NoError(t, err)
	require.Len(t, moderated, 2, "a moderator sees the review queue")

	own, err := service.ListOwn(ctx, actor("someone", site.RoleMember), KindArticle, 10)
	require.NoError(t, err)
	require.Len(t, own, 2, "an author sees their own work in every state")
}

func TestListRejectsUnknownKind(t *testing.T) {
	service := newService(t, newFakeRepo(), okSanitizer(), site.PublishModeReview)

	_, err := service.List(context.Background(), actor("u", site.RoleMember), Kind("comment"), 10, ListFilter{})
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestListAfterIssuesCursorOnlyOnFullPage(t *testing.T) {
	repo := newFakeRepo()
	for i := 0; i < 3; i++ {
		id := string(rune('a' + i))
		repo.items[id] = Content{ID: id, SiteID: "s1", AuthorID: "u", Kind: KindArticle,
			Status: StatusPublished}
	}
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	ctx := context.Background()

	page1, next, err := service.ListAfter(ctx, actor("mod", site.RoleEditor), KindArticle, 2, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, page1, 2)
	require.NotEmpty(t, next, "a full page must hand out a cursor")

	// A short page ends the listing; no cursor means the client stops asking.
	all, last, err := service.ListAfter(ctx, actor("mod", site.RoleEditor), KindArticle, 5, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, all, 3)
	require.Empty(t, last)
}

func TestListAfterRejectsBadKind(t *testing.T) {
	service := newService(t, newFakeRepo(), okSanitizer(), site.PublishModeReview)
	_, _, err := service.ListAfter(context.Background(), actor("u", site.RoleMember), Kind("x"), 5, page.Cursor{})
	require.ErrorIs(t, err, ErrInvalidInput)
}

// TestListAfterFilterNarrowsToOneAuthor pins the author archive contract: author_id
// only narrows the page, it never widens what the caller may see.
func TestListAfterFilterNarrowsToOneAuthor(t *testing.T) {
	repo := newFakeRepo()
	repo.items["alice-pub"] = Content{ID: "alice-pub", SiteID: "s1", AuthorID: "alice",
		Kind: KindArticle, Status: StatusPublished}
	repo.items["alice-draft"] = Content{ID: "alice-draft", SiteID: "s1", AuthorID: "alice",
		Kind: KindArticle, Status: StatusDraft}
	repo.items["bob-pub"] = Content{ID: "bob-pub", SiteID: "s1", AuthorID: "bob",
		Kind: KindArticle, Status: StatusPublished}

	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	ctx := context.Background()

	// A reader gets the author's published work only, never the draft.
	readerItems, readerNext, err := service.ListAfterFilter(ctx,
		actor("reader", site.RoleMember), KindArticle, 10, page.Cursor{}, ListFilter{AuthorID: "alice"})
	require.NoError(t, err)
	require.Len(t, readerItems, 1)
	require.Equal(t, "alice-pub", readerItems[0].ID)
	require.Empty(t, readerNext)

	// A moderator keeps the existing visibility rule under the same filter.
	editorItems, _, err := service.ListAfterFilter(ctx,
		actor("mod", site.RoleEditor), KindArticle, 10, page.Cursor{}, ListFilter{AuthorID: "alice"})
	require.NoError(t, err)
	editorIDs := make([]string, 0, len(editorItems))
	for _, item := range editorItems {
		editorIDs = append(editorIDs, item.ID)
	}
	require.ElementsMatch(t, []string{"alice-pub", "alice-draft"}, editorIDs)

	// An unknown author is an empty page, not a validation error: archive links can
	// outlive the account they point at.
	empty, next, err := service.ListAfterFilter(ctx,
		actor("reader", site.RoleMember), KindArticle, 10, page.Cursor{}, ListFilter{AuthorID: "ghost"})
	require.NoError(t, err)
	require.Empty(t, empty)
	require.Empty(t, next)
}
func TestSearchOnlyReturnsPublished(t *testing.T) {
	repo := newFakeRepo()
	repo.items["pub"] = Content{ID: "pub", SiteID: "s1", Kind: KindArticle,
		Status: StatusPublished, Title: "Go testing"}
	repo.items["draft"] = Content{ID: "draft", SiteID: "s1", Kind: KindArticle,
		Status: StatusDraft, Title: "Go draft"}

	service := newService(t, repo, okSanitizer(), site.PublishModeReview)
	result, err := service.Search(context.Background(), actor("reader", site.RoleMember), SearchQuery{
		Term: "Go", Kind: KindArticle, Limit: 10,
	})
	require.NoError(t, err)
	require.Len(t, result.Hits, 1)
	require.Equal(t, "pub", result.Hits[0].Content.ID, "a draft must never surface in search")
}

func TestSearchValidatesTerm(t *testing.T) {
	service := newService(t, newFakeRepo(), okSanitizer(), site.PublishModeReview)
	ctx := context.Background()

	_, err := service.Search(ctx, actor("u", site.RoleMember), SearchQuery{
		Term: " a ", Kind: KindArticle, Limit: 10,
	})
	require.ErrorIs(t, err, ErrInvalidInput, "a one character term is refused")

	_, err = service.Search(ctx, actor("u", site.RoleMember), SearchQuery{
		Term: "go", Kind: Kind("comment"), Limit: 10,
	})
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestSearchBoundsLongTerms(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeReview)

	long := make([]rune, MaxSearchTerm+50)
	for i := range long {
		long[i] = 'a'
	}

	result, err := service.Search(context.Background(), actor("u", site.RoleMember), SearchQuery{
		Term: string(long), Kind: KindArticle, Limit: 10,
	})
	require.NoError(t, err)
	require.Empty(t, result.Hits)
}
