package contentstore_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/site"
)

type sanitizer struct {
	err     error
	html    string
	version string
}

func (s *sanitizer) Sanitize(context.Context, content.SourceFormat, string) (content.Sanitized, error) {
	if s.err != nil {
		return content.Sanitized{}, s.err
	}
	return content.Sanitized{HTML: s.html, PolicyVersion: s.version}, nil
}

type harness struct {
	service *content.Service
	sanit   *sanitizer
	db      *db.DB
	siteID  string
	// now is the service clock; tests move it forward to trigger a schedule.
	now time.Time
	// hasher and unlocks are the deterministic stand-ins for the security service
	// and the signed unlock grant.
	hasher  content.AccessPasswordHasher
	unlocks content.UnlockTokens
}

// fakeHasher is a deterministic password hasher: the encoded form is "hash:<plain>".
// It keeps the integration test fast while still exercising the verify path.
type fakeHasher struct{}

func (fakeHasher) Hash(_ context.Context, plain string) (string, error) {
	return "hash:" + plain, nil
}

func (fakeHasher) Verify(_ context.Context, plain, encoded string) (bool, error) {
	return encoded == "hash:"+plain, nil
}

// fakeUnlocks mints a token bound to one item and verifies it strictly.
type fakeUnlocks struct{}

func (fakeUnlocks) IssueContentUnlock(
	_ context.Context, siteID, contentID string,
) (string, time.Time, error) {
	return "unlock:" + siteID + ":" + contentID, time.Unix(0, 0).Add(12 * time.Hour), nil
}

func (fakeUnlocks) VerifyContentUnlock(_ context.Context, token, siteID, contentID string) bool {
	return token == "unlock:"+siteID+":"+contentID
}

func newHarness(t *testing.T, mode site.PublishMode) *harness {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "content.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	san := &sanitizer{html: "<p>safe</p>", version: "policy-1"}

	h := &harness{
		sanit:   san,
		db:      handle,
		siteID:  siteRow.ID,
		now:     time.Date(2026, 11, 7, 9, 0, 0, 0, time.UTC),
		hasher:  fakeHasher{},
		unlocks: fakeUnlocks{},
	}

	service, err := content.NewService(content.ServiceConfig{
		Repository: contentstore.New(handle.Client, handle),
		Sanitizer:  san,
		PublishMode: func(context.Context, string) (site.PublishMode, error) {
			return mode, nil
		},
		AccessPasswordHasher: h.hasher,
		UnlockTokens:         h.unlocks,
		Now:                  func() time.Time { return h.now },
	})
	require.NoError(t, err)
	h.service = service

	return h
}

func (h *harness) author() content.Actor {
	return content.Actor{UserID: "author_1", SiteID: h.siteID, Role: site.RoleMember}
}

func (h *harness) editor() content.Actor {
	return content.Actor{UserID: "editor_1", SiteID: h.siteID, Role: site.RoleEditor}
}

func draftInput() content.DraftInput {
	return content.DraftInput{
		Title:        "Hello World",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# Hello",
	}
}

func TestContentLifecycle(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	ctx := context.Background()

	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, draftInput())
	require.NoError(t, err)
	require.Equal(t, content.StatusDraft, item.Status)
	require.Equal(t, "<p>safe</p>", item.RenderedHTML)
	require.Equal(t, "policy-1", item.PolicyVersion)

	submitted, err := h.service.Apply(ctx, h.author(), item.ID, content.ActionSubmit, "")
	require.NoError(t, err)
	require.Equal(t, content.StatusPendingReview, submitted.Status)

	published, err := h.service.Apply(ctx, h.editor(), item.ID, content.ActionPublish, "ok")
	require.NoError(t, err)
	require.Equal(t, content.StatusPublished, published.Status)
	require.NotNil(t, published.PublishedAt)

	archived, err := h.service.Apply(ctx, h.author(), item.ID, content.ActionArchive, "")
	require.NoError(t, err)
	require.Equal(t, content.StatusArchived, archived.Status)
	require.NotNil(t, archived.ArchivedAt)

	// The audit trail recorded every move.
	entries, err := h.db.Client.AuditLog.Query().All(ctx)
	require.NoError(t, err)
	require.Len(t, entries, 4, "create, submit, publish, archive")
}

func TestCreateDraftFailsClosedAndPersists(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	h.sanit.err = errors.New("security down")

	item, err := h.service.CreateDraft(context.Background(), h.author(), content.KindPost, draftInput())

	require.ErrorIs(t, err, content.ErrSecurityUnavailable)
	require.Equal(t, content.StatusPendingSecurityCheck, item.Status)
	require.Empty(t, item.RenderedHTML)

	// The row exists, so the author's work survives the outage.
	stored, err := h.service.Get(context.Background(), h.author(), item.ID)
	require.NoError(t, err)
	require.Equal(t, content.StatusPendingSecurityCheck, stored.Status)
}

func TestStaleTransitionIsRejected(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	ctx := context.Background()

	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, draftInput())
	require.NoError(t, err)
	_, err = h.service.Apply(ctx, h.author(), item.ID, content.ActionSubmit, "")
	require.NoError(t, err)

	_, err = h.service.Apply(ctx, h.editor(), item.ID, content.ActionPublish, "")
	require.NoError(t, err)

	// A moderator acting on the stale pending_review state is refused.
	_, err = h.service.Apply(ctx, h.editor(), item.ID, content.ActionReject, "")
	require.ErrorIs(t, err, content.ErrInvalidTransition)

	stored, err := h.db.Client.ContentItem.Get(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, string(content.StatusPublished), stored.Status)
}

func TestCrossSiteReadIsDenied(t *testing.T) {
	h := newHarness(t, site.PublishModeReview)
	ctx := context.Background()

	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, draftInput())
	require.NoError(t, err)

	other := content.Actor{UserID: "author_1", SiteID: "other_site", Role: site.RoleMember}
	_, err = h.service.Get(ctx, other, item.ID)
	require.ErrorIs(t, err, content.ErrNotFound)
}

func TestPublishedContentRevisionKeepsStatusAndHistory(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, draftInput())
	require.NoError(t, err)
	_, err = h.service.Apply(ctx, h.author(), item.ID, content.ActionPublish, "")
	require.NoError(t, err)

	revised := draftInput()
	revised.SourceBody = "# Revised"
	updated, err := h.service.UpdateDraft(ctx, h.author(), item.ID, revised)
	require.NoError(t, err)
	require.Equal(t, content.StatusPublished, updated.Status, "revision keeps the item live")
	require.Equal(t, "# Revised", updated.SourceBody)

	history, err := h.service.ListRevisions(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.Len(t, history, 2)
	require.Equal(t, content.RevisionUpdated, history[0].Action)
	require.Equal(t, "# Revised", history[0].SourceBody)
	require.Equal(t, content.RevisionCreated, history[1].Action)

	restored, err := h.service.RestoreRevision(ctx, h.author(), item.ID, history[1].ID)
	require.NoError(t, err)
	require.Equal(t, content.StatusPublished, restored.Status)
	require.Equal(t, draftInput().SourceBody, restored.SourceBody)

	history, err = h.service.ListRevisions(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.Len(t, history, 4, "rollback writes a backup and the restored version")
	require.Equal(t, content.RevisionRollback, history[0].Action)
	require.Equal(t, content.RevisionRollbackBackup, history[1].Action)
	require.Equal(t, "# Revised", history[1].SourceBody)
}

func TestRevisionHistoryKeepsOnlyNewestTwentyVersions(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, draftInput())
	require.NoError(t, err)

	for i := 0; i < content.RevisionRetention+5; i++ {
		in := draftInput()
		in.SourceBody = fmt.Sprintf("# revision %d", i)
		_, err := h.service.UpdateDraft(ctx, h.author(), item.ID, in)
		require.NoError(t, err)
	}

	history, err := h.service.ListRevisions(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.Len(t, history, content.RevisionRetention)
	// 1 create + 25 updates = version 26, so the retained window is 7..26.
	require.Equal(t, 26, history[0].Version)
	require.Equal(t, 7, history[len(history)-1].Version)
}

func TestStaleRevisionWriteIsRejected(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()
	store := contentstore.New(h.db.Client)

	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, draftInput())
	require.NoError(t, err)

	stale, err := store.FindByID(ctx, h.siteID, item.ID)
	require.NoError(t, err)

	fresh := stale
	fresh.SourceBody = "# first"
	fresh.UpdatedAt = time.Now().UTC()
	_, err = store.SaveDraft(ctx, fresh, site.AuditEntry{
		SiteID: h.siteID, ActorID: h.author().UserID, Action: "content.updated",
	})
	require.NoError(t, err)

	// The second writer still holds the old revision and must not overwrite.
	_, err = store.SaveDraft(ctx, stale, site.AuditEntry{
		SiteID: h.siteID, ActorID: h.author().UserID, Action: "content.updated",
	})
	require.ErrorIs(t, err, content.ErrConflict)

	stored, err := store.FindByID(ctx, h.siteID, item.ID)
	require.NoError(t, err)
	require.Equal(t, "# first", stored.SourceBody)
}
