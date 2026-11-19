package moderationstore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/infrastructure/moderationstore"
	"github.com/practacu/practacu-press/internal/moderation"
	"github.com/practacu/practacu-press/internal/site"
)

func newStore(t *testing.T) (*moderationstore.Store, string) {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "moderation.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	return moderationstore.New(handle.Client), siteRow.ID
}

func report(siteID, targetID string) moderation.Report {
	now := time.Now().UTC()
	return moderation.Report{
		SiteID: siteID, ReporterID: "u1", TargetType: "article", TargetID: targetID,
		Reason: moderation.ReasonSpam, Status: moderation.StatusOpen,
		CreatedAt: now, UpdatedAt: now,
	}
}

func TestReportLifecycle(t *testing.T) {
	store, siteID := newStore(t)
	ctx := context.Background()

	created, err := store.InsertReport(ctx, report(siteID, "a1"))
	require.NoError(t, err)
	require.Equal(t, moderation.StatusOpen, created.Status)

	found, err := store.FindReport(ctx, siteID, created.ID)
	require.NoError(t, err)
	require.Equal(t, "a1", found.TargetID)

	_, err = store.FindReport(ctx, "other-site", created.ID)
	require.ErrorIs(t, err, moderation.ErrNotFound, "reports are site scoped")

	updated := found
	updated.Status = moderation.StatusAssigned
	updated.AssigneeID = "mod1"
	saved, err := store.UpdateReport(ctx, updated)
	require.NoError(t, err)
	require.Equal(t, moderation.StatusAssigned, saved.Status)
	require.Equal(t, "mod1", saved.AssigneeID)
}

// TestDuplicateReportIsRejected proves the unique index is the duplicate guard.
func TestDuplicateReportIsRejected(t *testing.T) {
	store, siteID := newStore(t)
	ctx := context.Background()

	_, err := store.InsertReport(ctx, report(siteID, "a1"))
	require.NoError(t, err)

	_, err = store.InsertReport(ctx, report(siteID, "a1"))
	require.ErrorIs(t, err, moderation.ErrInvalidInput, "one report per reporter and target")
}

func TestListOpenExcludesClosed(t *testing.T) {
	store, siteID := newStore(t)
	ctx := context.Background()

	open, err := store.InsertReport(ctx, report(siteID, "a1"))
	require.NoError(t, err)
	closed, err := store.InsertReport(ctx, report(siteID, "a2"))
	require.NoError(t, err)

	done := closed
	done.Status = moderation.StatusResolved
	_, err = store.UpdateReport(ctx, done)
	require.NoError(t, err)

	queue, err := store.ListOpen(ctx, siteID, 10)
	require.NoError(t, err)
	require.Len(t, queue, 1)
	require.Equal(t, open.ID, queue[0].ID)
}

func TestServiceAgainstRealStore(t *testing.T) {
	store, siteID := newStore(t)
	ctx := context.Background()

	service, err := moderation.NewService(store)
	require.NoError(t, err)

	reporter := moderation.Actor{UserID: "u1", SiteID: siteID, Role: site.RoleMember}
	editor := moderation.Actor{UserID: "mod1", SiteID: siteID, Role: site.RoleEditor}

	filed, err := service.File(ctx, reporter, moderation.NewReportInput{
		TargetType: "article", TargetID: "a1", Reason: moderation.ReasonSpam,
	}, "author-1")
	require.NoError(t, err)

	_, err = service.Assign(ctx, editor, filed.ID)
	require.NoError(t, err)

	resolved, err := service.Resolve(ctx, editor, filed.ID, false, "removed")
	require.NoError(t, err)
	require.Equal(t, moderation.StatusResolved, resolved.Status)

	queue, err := service.Queue(ctx, editor, 10)
	require.NoError(t, err)
	require.Empty(t, queue, "a resolved report leaves the queue")
}
