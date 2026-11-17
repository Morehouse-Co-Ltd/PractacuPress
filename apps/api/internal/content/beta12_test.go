package content

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/preview"
	"github.com/practacu/practacu-press/apps/api/internal/platform/textdiff"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Beta 1.2 endpoints: version diff (E), version conflict (F), batch actions (G), draft
// preview (H), unpublish (I) and slug addressing plus the module adapters (J).

// The two optional Beta 1.2 storage capabilities are implemented by the in-memory
// repository exactly like the content store implements them, so the service paths under
// test are the production ones.

func (f *fakeRepo) FindBySlug(
	_ context.Context,
	siteID string,
	kind Kind,
	slug string,
) (Content, error) {
	var found *Content
	for _, item := range f.items {
		if item.SiteID != siteID || item.IsTrashed() || item.Slug != slug {
			continue
		}
		if kind != "" && item.Kind != kind {
			continue
		}
		candidate := item
		if found == nil || candidate.CreatedAt.Before(found.CreatedAt) {
			found = &candidate
		}
	}
	if found == nil {
		return Content{}, ErrNotFound
	}
	return *found, nil
}

func (f *fakeRepo) FindRevisionByVersion(
	_ context.Context,
	siteID, contentID string,
	version int,
) (Revision, error) {
	for _, revision := range f.revisions {
		if revision.SiteID == siteID && revision.ContentID == contentID && revision.Version == version {
			return revision, nil
		}
	}
	return Revision{}, ErrNotFound
}

// betaNow is the fixed clock of the Beta 1.2 tests.
func betaNow() time.Time { return time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC) }

// betaClock is a movable clock, so the preview expiry can be crossed without sleeping.
type betaClock struct{ at time.Time }

func (c *betaClock) now() time.Time { return c.at }

// newBetaService builds a Service with the defaults a Beta 1.2 test usually wants:
// an in-memory repository, an accepting sanitizer, open publishing and a fixed clock.
func newBetaService(t *testing.T, repo *fakeRepo, tweak func(*ServiceConfig)) *Service {
	t.Helper()
	cfg := ServiceConfig{
		Repository: repo,
		Sanitizer:  okSanitizer(),
		PublishMode: func(context.Context, string) (site.PublishMode, error) {
			return site.PublishModeOpen, nil
		},
		Now: betaNow,
	}
	if tweak != nil {
		tweak(&cfg)
	}
	service, err := NewService(cfg)
	require.NoError(t, err)
	return service
}

// betaHasher is a deterministic access password hasher.
type betaHasher struct{}

func (betaHasher) Hash(_ context.Context, plain string) (string, error) { return "hash:" + plain, nil }

func (betaHasher) Verify(_ context.Context, plain, encoded string) (bool, error) {
	return encoded == "hash:"+plain, nil
}

// createPublished is the short path to a published article with the given slug.
func createPublished(
	t *testing.T,
	service *Service,
	author Actor,
	slug string,
) Content {
	t.Helper()
	ctx := context.Background()
	in := DraftInput{
		Title:        "Hello World",
		Slug:         slug,
		SourceFormat: FormatMarkdown,
		SourceBody:   "# Hello",
	}
	item, err := service.CreateDraft(ctx, author, KindArticle, in)
	require.NoError(t, err)
	published, err := service.Apply(ctx, author, item.ID, ActionPublish, "")
	require.NoError(t, err)
	require.Equal(t, StatusPublished, published.Status)
	return published
}

func TestUnpublishReturnsPublishedItemToDraft(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	author := actor("author", site.RoleMember)

	item := createPublished(t, service, author, "hello-world")
	require.NotNil(t, item.PublishedAt)

	// The action list advertises the new move (contract I).
	actions, err := service.Actions(ctx, author, item)
	require.NoError(t, err)
	require.Contains(t, actions, ActionUnpublish)

	withdrawn, err := service.Apply(ctx, author, item.ID, ActionUnpublish, "")
	require.NoError(t, err)
	require.Equal(t, StatusDraft, withdrawn.Status)
	require.Nil(t, withdrawn.PublishedAt, "unpublish clears published_at")
	require.Nil(t, withdrawn.ArchivedAt)
	require.Equal(t, item.Revision, withdrawn.Revision, "withdrawing is not a text revision")

	// The move only exists from published.
	_, err = service.Apply(ctx, author, item.ID, ActionUnpublish, "")
	require.ErrorIs(t, err, ErrInvalidTransition)

	// Once back in draft the item can be published again.
	republished, err := service.Apply(ctx, author, item.ID, ActionPublish, "")
	require.NoError(t, err)
	require.Equal(t, StatusPublished, republished.Status)
}

func TestUnpublishRequiresAuthorshipOrEditor(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	author := actor("author", site.RoleMember)
	stranger := actor("stranger", site.RoleMember)
	editor := actor("editor", site.RoleEditor)

	item := createPublished(t, service, author, "hello-world")

	_, err := service.Apply(ctx, stranger, item.ID, ActionUnpublish, "")
	require.ErrorIs(t, err, ErrPermissionDenied)

	// Nobody but the author or an editor may withdraw the item.
	available, err := service.Actions(ctx, stranger, item)
	require.NoError(t, err)
	require.NotContains(t, available, ActionUnpublish)

	withdrawn, err := service.Apply(ctx, editor, item.ID, ActionUnpublish, "")
	require.NoError(t, err)
	require.Equal(t, StatusDraft, withdrawn.Status)
}

func TestUpdateDraftRejectsStaleRevision(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	author := actor("author", site.RoleMember)

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)
	require.Equal(t, 1, item.Revision)

	stale := item.Revision + 1
	in := sampleDraft()
	in.Revision = &stale
	_, err = service.UpdateDraft(ctx, author, item.ID, in)
	var conflict *VersionConflictError
	require.ErrorAs(t, err, &conflict)
	require.Equal(t, item.Revision, conflict.Current)
	require.ErrorIs(t, err, ErrConflict)

	// The stored item did not move.
	stored, err := service.Get(ctx, author, item.ID)
	require.NoError(t, err)
	require.Equal(t, item.Revision, stored.Revision)

	// The matching token succeeds and advances the revision.
	current := item.Revision
	in = sampleDraft()
	in.Revision = &current
	updated, err := service.UpdateDraft(ctx, author, item.ID, in)
	require.NoError(t, err)
	require.Equal(t, item.Revision+1, updated.Revision)

	// No token keeps the historical last-write-wins behaviour.
	in = sampleDraft()
	in.SourceBody = "# Changed"
	in.Revision = nil
	_, err = service.UpdateDraft(ctx, author, item.ID, in)
	require.NoError(t, err)
}

func TestDiffBetweenRevisions(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	author := actor("author", site.RoleMember)
	stranger := actor("stranger", site.RoleMember)

	item, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title:        "Hello",
		SourceFormat: FormatMarkdown,
		SourceBody:   "line one\nline two",
	})
	require.NoError(t, err)

	first := DraftInput{Title: "Hello", SourceFormat: FormatMarkdown, SourceBody: "line one\nline TWO"}
	_, err = service.UpdateDraft(ctx, author, item.ID, first)
	require.NoError(t, err)
	second := DraftInput{Title: "Hello", SourceFormat: FormatMarkdown, SourceBody: "line one\nline TWO\nline three"}
	updated, err := service.UpdateDraft(ctx, author, item.ID, second)
	require.NoError(t, err)
	require.Equal(t, 3, updated.Revision)

	result, err := service.Diff(ctx, author, item.ID, "1", CurrentRevision)
	require.NoError(t, err)
	require.Equal(t, 1, result.FromVersion)
	require.Equal(t, 3, result.ToVersion)
	require.False(t, result.Truncated)
	require.NotEmpty(t, result.Hunks)
	// "line two" became "line TWO" and a third line was appended.
	require.GreaterOrEqual(t, result.Stats.Added, 1)
	require.GreaterOrEqual(t, result.Stats.Removed, 1)

	// Replaying the hunks reconstructs both source documents.
	var fromText, toText strings.Builder
	for _, hunk := range result.Hunks {
		switch hunk.Op {
		case textdiff.OpEqual:
			fromText.WriteString(hunk.Text)
			fromText.WriteString("\n")
			toText.WriteString(hunk.Text)
			toText.WriteString("\n")
		case textdiff.OpDelete:
			fromText.WriteString(hunk.Text)
			fromText.WriteString("\n")
		case textdiff.OpInsert:
			toText.WriteString(hunk.Text)
			toText.WriteString("\n")
		}
	}
	revisionOne, err := repo.FindRevisionByVersion(ctx, author.SiteID, item.ID, 1)
	require.NoError(t, err)
	require.Equal(t, strings.TrimSuffix(revisionOne.SourceBody, "\n")+"\n", fromText.String())
	require.Equal(t, strings.TrimSuffix(second.SourceBody, "\n")+"\n", toText.String())

	// Explicit two version diff.
	explicit, err := service.Diff(ctx, author, item.ID, "2", "3")
	require.NoError(t, err)
	require.Equal(t, 2, explicit.FromVersion)
	require.Equal(t, 3, explicit.ToVersion)

	// Request level validation.
	_, err = service.Diff(ctx, author, item.ID, "", "current")
	require.ErrorIs(t, err, ErrInvalidInput)
	_, err = service.Diff(ctx, author, item.ID, "not-a-version", "current")
	require.ErrorIs(t, err, ErrInvalidInput)
	_, err = service.Diff(ctx, author, item.ID, "99", "current")
	require.ErrorIs(t, err, ErrNotFound)

	// The history permission rule applies: a stranger gets 404, not a permission error.
	_, err = service.Diff(ctx, stranger, item.ID, "1", "current")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestDiffTruncatesLongDocuments(t *testing.T) {
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	ctx := context.Background()
	author := actor("author", site.RoleMember)

	body := strings.Repeat("line\n", 20001)
	item := Content{
		ID: "big", SiteID: author.SiteID, AuthorID: author.UserID, Kind: KindArticle,
		Status: StatusDraft, Title: "Big", Slug: "big",
		SourceBody: body, RenderedHTML: "<p>big</p>", PolicyVersion: "p1",
		Revision: 2, CreatedAt: betaNow(), UpdatedAt: betaNow(),
	}
	repo.items[item.ID] = item
	repo.revisions = append(repo.revisions, Revision{
		ID: "r1", SiteID: author.SiteID, ContentID: "big", Version: 1,
		Status: StatusDraft, Title: "Big", SourceBody: body,
	})

	result, err := service.Diff(ctx, author, item.ID, "1", "current")
	require.NoError(t, err)
	require.True(t, result.Truncated)
	require.Len(t, result.Hunks, 20000)
	require.Equal(t, 0, result.Stats.Added)
	require.Equal(t, 0, result.Stats.Removed)
}

func TestBulkPartialSuccess(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	author := actor("author", site.RoleMember)
	other := actor("other", site.RoleMember)

	mine, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)
	theirs, err := service.CreateDraft(ctx, other, KindArticle, sampleDraft())
	require.NoError(t, err)

	result, err := service.Bulk(ctx, author, KindArticle, []string{mine.ID, theirs.ID, "missing"}, "publish")
	require.NoError(t, err)
	require.Len(t, result.Results, 3)
	require.Equal(t, 1, result.Succeeded)
	require.Equal(t, 2, result.Failed)

	require.True(t, result.Results[0].OK)
	require.Empty(t, result.Results[0].Error)
	require.Equal(t, mine.ID, result.Results[0].ID)

	require.False(t, result.Results[1].OK)
	require.Equal(t, "permission_denied", result.Results[1].Error)
	require.Equal(t, theirs.ID, result.Results[1].ID)

	require.False(t, result.Results[2].OK)
	require.Equal(t, "not_found", result.Results[2].Error)

	// The successful item really moved; the refused one did not.
	published, err := service.Get(ctx, author, mine.ID)
	require.NoError(t, err)
	require.Equal(t, StatusPublished, published.Status)
	stillDraft, err := service.Get(ctx, other, theirs.ID)
	require.NoError(t, err)
	require.Equal(t, StatusDraft, stillDraft.Status)
}

func TestBulkLifecycleActions(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	author := actor("author", site.RoleMember)

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)

	// Purge refuses a live item: the two step delete is still the only destruction path,
	// and the refusal is reported per item rather than as a failed batch.
	refused, err := service.Bulk(ctx, author, KindArticle, []string{item.ID}, "purge")
	require.NoError(t, err)
	require.Equal(t, 1, refused.Failed)
	require.Equal(t, "content_state_invalid", refused.Results[0].Error)

	trashed, err := service.Bulk(ctx, author, KindArticle, []string{item.ID}, "trash")
	require.NoError(t, err)
	require.Equal(t, 1, trashed.Succeeded)
	_, err = service.Get(ctx, author, item.ID)
	require.ErrorIs(t, err, ErrNotFound)

	restored, err := service.Bulk(ctx, author, KindArticle, []string{item.ID}, "undelete")
	require.NoError(t, err)
	require.Equal(t, 1, restored.Succeeded)
	live, err := service.Get(ctx, author, item.ID)
	require.NoError(t, err)
	require.Equal(t, StatusDraft, live.Status)

	// A purge of a trashed item succeeds and removes it.
	_, err = service.Bulk(ctx, author, KindArticle, []string{item.ID}, "trash")
	require.NoError(t, err)
	purged, err := service.Bulk(ctx, author, KindArticle, []string{item.ID}, "purge")
	require.NoError(t, err)
	require.Equal(t, 1, purged.Succeeded)
	_, err = service.Get(ctx, author, item.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestBulkValidatesRequest(t *testing.T) {
	ctx := context.Background()
	service := newBetaService(t, newFakeRepo(), nil)
	author := actor("author", site.RoleMember)

	_, err := service.Bulk(ctx, author, KindArticle, nil, "publish")
	require.ErrorIs(t, err, ErrInvalidInput)

	_, err = service.Bulk(ctx, author, KindArticle, []string{"a"}, "reject")
	require.ErrorIs(t, err, ErrInvalidInput, "reject is a moderation decision, not a batch action")

	tooMany := make([]string, MaxBulkItems+1)
	for i := range tooMany {
		tooMany[i] = "id"
	}
	_, err = service.Bulk(ctx, author, KindArticle, tooMany, "publish")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestUnpublishByAuthorInReviewMode(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, func(cfg *ServiceConfig) {
		cfg.PublishMode = func(context.Context, string) (site.PublishMode, error) {
			return site.PublishModeReview, nil
		}
	})
	author := actor("author", site.RoleMember)
	editor := actor("editor", site.RoleEditor)

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)
	_, err = service.Apply(ctx, author, item.ID, ActionSubmit, "")
	require.NoError(t, err)
	published, err := service.Apply(ctx, editor, item.ID, ActionPublish, "")
	require.NoError(t, err)
	require.Equal(t, StatusPublished, published.Status)

	// Taking one's own work down does not need the publish right that skipping review
	// needs: contract I grants it to the author.
	withdrawn, err := service.Apply(ctx, author, item.ID, ActionUnpublish, "")
	require.NoError(t, err)
	require.Equal(t, StatusDraft, withdrawn.Status)
	require.Nil(t, withdrawn.PublishedAt)
}

func TestPreviewTokenLetsAnonymousReadDraft(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	clock := &betaClock{at: betaNow()}
	signer, err := preview.New(preview.Options{
		Key: []byte("0123456789abcdef0123456789abcdef"),
		Now: clock.now,
	})
	require.NoError(t, err)

	service := newBetaService(t, repo, func(cfg *ServiceConfig) {
		cfg.PreviewSigner = signer
	})
	author := actor("author", site.RoleMember)
	draft, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title:        "Secret Draft",
		Slug:         "secret-draft",
		SourceFormat: FormatMarkdown,
		SourceBody:   "# secret",
	})
	require.NoError(t, err)

	// The author mints the link; a non-privileged caller gets a 404, not a permission
	// error, so the draft's existence is not confirmed.
	_, err = service.IssuePreview(ctx, actor("stranger", site.RoleMember), draft.ID)
	require.ErrorIs(t, err, ErrNotFound)

	grant, err := service.IssuePreview(ctx, author, draft.ID)
	require.NoError(t, err)
	require.NotEmpty(t, grant.Token)
	require.Equal(t, betaNow().Add(PreviewTokenTTL), grant.ExpiresAt)
	require.Equal(t, "/a/secret-draft?preview_token="+grant.Token, grant.Path)

	// An anonymous reader without the token is refused ...
	anonymous := Actor{SiteID: author.SiteID}
	_, err = service.ReadWithPreview(ctx, anonymous, draft.ID, "", false)
	require.ErrorIs(t, err, ErrNotFound)

	// ... and with the token gets the unpublished draft.
	read, err := service.ReadWithPreview(ctx, anonymous, draft.ID, grant.Token, false)
	require.NoError(t, err)
	require.Equal(t, draft.ID, read.ID)
	require.Equal(t, StatusDraft, read.Status)

	// A token only works for the item it was minted for.
	other, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)
	_, err = service.ReadWithPreview(ctx, anonymous, other.ID, grant.Token, false)
	require.ErrorIs(t, err, ErrNotFound)

	// Once expired the token is treated as absent.
	clock.at = grant.ExpiresAt.Add(time.Second)
	_, err = service.ReadWithPreview(ctx, anonymous, draft.ID, grant.Token, false)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestPreviewStillHonoursAccessMode(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	signer, err := preview.New(preview.Options{
		Key: []byte("0123456789abcdef0123456789abcdef"),
		Now: betaNow,
	})
	require.NoError(t, err)
	service := newBetaService(t, repo, func(cfg *ServiceConfig) {
		cfg.PreviewSigner = signer
		cfg.AccessPasswordHasher = betaHasher{}
	})
	author := actor("author", site.RoleMember)

	draft, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title:          "Locked Draft",
		Slug:           "locked-draft",
		SourceFormat:   FormatMarkdown,
		SourceBody:     "# locked",
		AccessMode:     AccessPassword,
		AccessPassword: "open-sesame",
	})
	require.NoError(t, err)

	grant, err := service.IssuePreview(ctx, author, draft.ID)
	require.NoError(t, err)

	// The preview bypasses unpublished status only: the password rule still applies.
	anonymous := Actor{SiteID: author.SiteID}
	_, err = service.ReadWithPreview(ctx, anonymous, draft.ID, grant.Token, false)
	require.ErrorIs(t, err, ErrPasswordRequired)

	read, err := service.ReadWithPreview(ctx, anonymous, draft.ID, grant.Token, true)
	require.NoError(t, err)
	require.Equal(t, draft.ID, read.ID)
}

func TestPreviewUnavailableWithoutSigner(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	author := actor("author", site.RoleMember)

	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)

	_, err = service.IssuePreview(ctx, author, item.ID)
	require.ErrorIs(t, err, ErrPreviewUnavailable)

	// The composition root can attach the signer after construction.
	signer, err := preview.New(preview.Options{
		Key: []byte("0123456789abcdef0123456789abcdef"),
		Now: betaNow,
	})
	require.NoError(t, err)
	service.SetPreviewSigner(signer)
	grant, err := service.IssuePreview(ctx, author, item.ID)
	require.NoError(t, err)
	require.NotEmpty(t, grant.Token)
}

func TestLocateResolvesPublishedPaths(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	author := actor("author", site.RoleMember)

	article := createPublished(t, service, author, "hello-world")

	contentID, slug, title, ok, err := service.Locate(ctx, author.SiteID, "article", "hello-world")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, article.ID, contentID)
	require.Equal(t, "hello-world", slug)
	require.Equal(t, article.Title, title)

	// An id form path resolves too, so a shared /a/{id} link can be redirected.
	byID, _, _, ok, err := service.Locate(ctx, author.SiteID, "article", article.ID)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, article.ID, byID)

	// A post path must not resolve an article.
	_, _, _, ok, err = service.Locate(ctx, author.SiteID, "post", "hello-world")
	require.NoError(t, err)
	require.False(t, ok)

	// A draft has no public address, and guessing one answers exactly like missing.
	draft, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title:        "Draft",
		Slug:         "hidden",
		SourceFormat: FormatMarkdown,
		SourceBody:   "# hidden",
	})
	require.NoError(t, err)
	_, _, _, ok, err = service.Locate(ctx, author.SiteID, "article", draft.ID)
	require.NoError(t, err)
	require.False(t, ok)
	_, _, _, ok, err = service.Locate(ctx, author.SiteID, "article", "missing")
	require.NoError(t, err)
	require.False(t, ok)
}

func TestDigestRendersTitleSummaryAndPath(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	author := actor("author", site.RoleMember)

	article := createPublished(t, service, author, "hello-world")
	title, summary, url, ok, err := service.Digest(ctx, author.SiteID, article.ID)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, article.Title, title)
	require.Equal(t, article.Summary, summary)
	require.Equal(t, "/a/hello-world", url)

	// The URL falls back to the id when the item has no slug.
	post, err := service.CreateDraft(ctx, author, KindPost, DraftInput{
		Title:        "中文标题",
		SourceFormat: FormatMarkdown,
		SourceBody:   "# body",
	})
	require.NoError(t, err)
	require.Empty(t, post.Slug, "a non ASCII title derives no slug")
	_, _, fallbackURL, ok, err := service.Digest(ctx, author.SiteID, post.ID)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "/p/"+post.ID, fallbackURL)

	// An unknown id is reported as missing, not as an error.
	_, _, _, ok, err = service.Digest(ctx, author.SiteID, "missing")
	require.NoError(t, err)
	require.False(t, ok)
}

// slugRecorder captures the automatic redirect calls of a slug change.
type slugRecorder struct{ calls []slugChange }

type slugChange struct{ siteID, from, to string }

func (r *slugRecorder) RecordSlugChange(_ context.Context, siteID, fromPath, toPath string) error {
	r.calls = append(r.calls, slugChange{siteID: siteID, from: fromPath, to: toPath})
	return nil
}

func TestSlugChangeOfPublishedItemRecordsRedirect(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	recorder := &slugRecorder{}
	service := newBetaService(t, repo, func(cfg *ServiceConfig) {
		cfg.RedirectRecorder = recorder
	})
	author := actor("author", site.RoleMember)

	item := createPublished(t, service, author, "old-slug")

	renamed := sampleDraft()
	renamed.Slug = "new-slug"
	_, err := service.UpdateDraft(ctx, author, item.ID, renamed)
	require.NoError(t, err)

	require.Len(t, recorder.calls, 1)
	require.Equal(t, slugChange{siteID: author.SiteID, from: "/a/old-slug", to: "/a/new-slug"}, recorder.calls[0])

	// Saving the same slug again records nothing.
	_, err = service.UpdateDraft(ctx, author, item.ID, renamed)
	require.NoError(t, err)
	require.Len(t, recorder.calls, 1)

	// A draft that changes its slug has no public address yet, so nothing is recorded.
	draft, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title:        "Draft",
		Slug:         "draft-one",
		SourceFormat: FormatMarkdown,
		SourceBody:   "# draft",
	})
	require.NoError(t, err)
	renamedDraft := sampleDraft()
	renamedDraft.Slug = "draft-two"
	_, err = service.UpdateDraft(ctx, author, draft.ID, renamedDraft)
	require.NoError(t, err)
	require.Len(t, recorder.calls, 1)
}

func TestResolveContentIDFallsBackToSlug(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	service := newBetaService(t, repo, nil)
	author := actor("author", site.RoleMember)

	item, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title:        "Hello",
		Slug:         "hello-world",
		SourceFormat: FormatMarkdown,
		SourceBody:   "# hello",
	})
	require.NoError(t, err)

	resolved, err := service.ResolveContentID(ctx, author.SiteID, KindArticle, "hello-world")
	require.NoError(t, err)
	require.Equal(t, item.ID, resolved)

	// The id path wins over a slug of a different item.
	byID, err := service.ResolveContentID(ctx, author.SiteID, KindArticle, item.ID)
	require.NoError(t, err)
	require.Equal(t, item.ID, byID)

	// The kind scoping keeps a post route from resolving an article slug.
	_, err = service.ResolveContentID(ctx, author.SiteID, KindPost, "hello-world")
	require.ErrorIs(t, err, ErrNotFound)

	// An unknown key is a missing resource.
	_, err = service.ResolveContentID(ctx, author.SiteID, KindArticle, "missing")
	require.ErrorIs(t, err, ErrNotFound)

	// The action resolver sees the recycle bin, the read resolver does not.
	_, err = service.Trash(ctx, author, item.ID)
	require.NoError(t, err)
	_, err = service.ResolveContentID(ctx, author.SiteID, KindArticle, item.ID)
	require.ErrorIs(t, err, ErrNotFound)
	actionID, err := service.ResolveActionContentID(ctx, author.SiteID, KindArticle, item.ID)
	require.NoError(t, err)
	require.Equal(t, item.ID, actionID)
}
