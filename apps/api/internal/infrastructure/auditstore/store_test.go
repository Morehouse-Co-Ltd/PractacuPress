package auditstore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/auditstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
)

func newStore(t *testing.T) (*auditstore.Store, string, string, string) {
	t.Helper()
	ctx := context.Background()
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "audit.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main Site").Save(ctx)
	require.NoError(t, err)
	userRow, err := handle.Client.User.Create().SetDisplayName("Alice").Save(ctx)
	require.NoError(t, err)

	return auditstore.New(handle.Client), siteRow.ID, userRow.ID, userRow.ID
}

func TestRecordAndListNewestFirstWithNames(t *testing.T) {
	store, siteID, actorID, targetID := newStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)

	for index, action := range []string{"content.created", "content.published", "auth.login"} {
		require.NoError(t, store.Record(ctx, audit.Entry{
			SiteID:     siteID,
			ActorID:    actorID,
			Action:     action,
			TargetType: "user",
			TargetID:   targetID,
			Detail:     map[string]any{"index": index},
			At:         base.Add(time.Duration(index) * time.Minute),
		}))
	}

	first, next, err := store.List(ctx, audit.Filter{SiteID: siteID}, 2, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, first, 2)
	require.NotEmpty(t, next)
	require.Equal(t, "auth.login", first[0].Action)
	require.Equal(t, "content.published", first[1].Action)
	require.Equal(t, "Alice", first[0].ActorName)
	require.Equal(t, "Alice", first[0].TargetName)
	require.Equal(t, "success", first[0].Outcome)

	cursor, err := page.Decode(next)
	require.NoError(t, err)
	rest, last, err := store.List(ctx, audit.Filter{SiteID: siteID}, 2, cursor)
	require.NoError(t, err)
	require.Len(t, rest, 1)
	require.Equal(t, "content.created", rest[0].Action)
	require.Empty(t, last)
}

func TestListAppliesEveryFilter(t *testing.T) {
	store, siteID, actorID, _ := newStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)

	require.NoError(t, store.Record(ctx, audit.Entry{
		SiteID: siteID, ActorID: actorID, Action: "content.published",
		TargetType: "article", TargetID: "c1", At: base,
	}))
	require.NoError(t, store.Record(ctx, audit.Entry{
		SiteID: siteID, ActorID: actorID, Action: "site.settings.updated",
		TargetType: "site", TargetID: siteID, At: base.Add(time.Hour),
	}))

	from := base.Add(30 * time.Minute)
	items, _, err := store.List(ctx, audit.Filter{
		SiteID:     siteID,
		Action:     "site.settings.updated",
		TargetType: "site",
		ActorID:    actorID,
		Outcome:    "success",
		From:       &from,
	}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "site.settings.updated", items[0].Action)

	// A missing action returns an empty page, not every row.
	none, _, err := store.List(ctx, audit.Filter{SiteID: siteID, Action: "content.archived"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Empty(t, none)
}

func TestListNeverLeaksAnotherSitesRows(t *testing.T) {
	store, siteID, actorID, _ := newStore(t)
	ctx := context.Background()

	require.NoError(t, store.Record(ctx, audit.Entry{
		SiteID: siteID, ActorID: actorID, Action: "content.created", At: time.Now().UTC(),
	}))
	items, _, err := store.List(ctx, audit.Filter{SiteID: "another-site"}, 50, page.Cursor{})
	require.NoError(t, err)
	require.Empty(t, items)
}
