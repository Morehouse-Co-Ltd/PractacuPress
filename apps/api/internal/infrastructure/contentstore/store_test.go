package contentstore_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/site"
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

	service, err := content.NewService(content.ServiceConfig{
		Repository: contentstore.New(handle.Client),
		Sanitizer:  san,
		PublishMode: func(context.Context, string) (site.PublishMode, error) {
			return mode, nil
		},
	})
	require.NoError(t, err)

	return &harness{service: service, sanit: san, db: handle, siteID: siteRow.ID}
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
	h.sanit.err = errors.New("grpc down")

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

func TestPublishedContentCannotBeEdited(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, draftInput())
	require.NoError(t, err)
	_, err = h.service.Apply(ctx, h.author(), item.ID, content.ActionPublish, "")
	require.NoError(t, err)

	_, err = h.service.UpdateDraft(ctx, h.author(), item.ID, draftInput())
	require.ErrorIs(t, err, content.ErrInvalidTransition)
}
