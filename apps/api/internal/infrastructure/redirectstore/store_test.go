package redirectstore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/redirectstore"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/redirect"
)

func newStore(t *testing.T) *redirectstore.Store {
	t.Helper()

	handle, err := db.Open(context.Background(), "sqlite",
		db.SQLiteDSN(filepath.Join(t.TempDir(), "redirects.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(context.Background()))
	return redirectstore.New(handle.Client)
}

func TestRedirectLifecycleAgainstSQLite(t *testing.T) {
	ctx := context.Background()
	base := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	store := newStore(t)

	first, err := store.Insert(ctx, redirect.Redirect{
		SiteID: "site_1", FromPath: "/a/old", ToPath: "/a/new",
		StatusCode: 301, Source: redirect.SourceManual,
		CreatedAt: base, UpdatedAt: base,
	})
	require.NoError(t, err)
	require.NotEmpty(t, first.ID)

	second, err := store.Insert(ctx, redirect.Redirect{
		SiteID: "site_1", FromPath: "/p/old", ToPath: "/p/new",
		StatusCode: 302, Source: redirect.SourceSlugChange,
		CreatedAt: base.Add(time.Minute), UpdatedAt: base.Add(time.Minute),
	})
	require.NoError(t, err)

	// The unique (site_id, from_path) index is the duplicate rule.
	_, err = store.Insert(ctx, redirect.Redirect{
		SiteID: "site_1", FromPath: "/a/old", ToPath: "/a/other",
		StatusCode: 301, Source: redirect.SourceManual,
		CreatedAt: base, UpdatedAt: base,
	})
	require.ErrorIs(t, err, redirect.ErrConflict)

	// The same path on another site is a different rule.
	other, err := store.Insert(ctx, redirect.Redirect{
		SiteID: "site_2", FromPath: "/a/old", ToPath: "/a/elsewhere",
		StatusCode: 301, Source: redirect.SourceManual,
		CreatedAt: base, UpdatedAt: base,
	})
	require.NoError(t, err)

	found, err := store.FindByPath(ctx, "site_1", "/a/old")
	require.NoError(t, err)
	require.Equal(t, first.ID, found.ID)

	_, err = store.FindByPath(ctx, "site_1", "/a/missing")
	require.ErrorIs(t, err, redirect.ErrNotFound)

	_, err = store.FindByID(ctx, "site_2", first.ID)
	require.ErrorIs(t, err, redirect.ErrNotFound, "an id from another site is not readable")

	// Newest first with a stable cursor; limit one then continue.
	firstPage, next, err := store.List(ctx, "site_1", "", 1, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, firstPage, 1)
	require.Equal(t, second.ID, firstPage[0].ID)
	require.NotEmpty(t, next)

	after, err := page.Decode(next)
	require.NoError(t, err)
	secondPage, rest, err := store.List(ctx, "site_1", "", 1, after)
	require.NoError(t, err)
	require.Len(t, secondPage, 1)
	require.Equal(t, first.ID, secondPage[0].ID)
	require.Empty(t, rest)

	// Fuzzy search over both sides of the rule.
	byFrom, _, err := store.List(ctx, "site_1", "OLD", 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byFrom, 2)

	byTo, _, err := store.List(ctx, "site_1", "/p/new", 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, byTo, 1)
	require.Equal(t, second.ID, byTo[0].ID)

	// The hit counter is a best effort increment.
	require.NoError(t, store.IncrementHitCount(ctx, "site_1", first.ID))
	require.NoError(t, store.IncrementHitCount(ctx, "site_1", first.ID))
	counted, err := store.FindByID(ctx, "site_1", first.ID)
	require.NoError(t, err)
	require.Equal(t, 2, counted.HitCount)

	// Update persists the mutable fields and keeps the source.
	updated := counted
	updated.ToPath = "/a/newer"
	updated.StatusCode = 308
	saved, err := store.Update(ctx, updated)
	require.NoError(t, err)
	require.Equal(t, "/a/newer", saved.ToPath)
	require.Equal(t, 308, saved.StatusCode)
	require.Equal(t, redirect.SourceManual, saved.Source)

	// Moving onto a path another rule owns is a conflict.
	colliding := saved
	colliding.FromPath = "/p/old"
	_, err = store.Update(ctx, colliding)
	require.ErrorIs(t, err, redirect.ErrConflict)

	require.NoError(t, store.Delete(ctx, "site_1", first.ID))
	_, err = store.FindByID(ctx, "site_1", first.ID)
	require.ErrorIs(t, err, redirect.ErrNotFound)
	require.ErrorIs(t, store.Delete(ctx, "site_1", first.ID), redirect.ErrNotFound)

	// The other tenant is untouched by all of the above.
	require.NoError(t, store.Delete(ctx, "site_2", other.ID))
}

func TestRecordSlugChangeAgainstSQLite(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	service, err := redirect.NewService(redirect.ServiceConfig{Repository: store})
	require.NoError(t, err)

	require.NoError(t, service.RecordSlugChange(ctx, "site_1", "/a/old", "/a/middle"))
	require.NoError(t, service.RecordSlugChange(ctx, "site_1", "/a/old", "/a/final"))

	rule, err := store.FindByPath(ctx, "site_1", "/a/old")
	require.NoError(t, err)
	require.Equal(t, "/a/final", rule.ToPath)
	require.Equal(t, 301, rule.StatusCode)
	require.Equal(t, redirect.SourceSlugChange, rule.Source)

	all, _, err := store.List(ctx, "site_1", "", 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, all, 1, "the automatic rule is replaced, not duplicated")
}
