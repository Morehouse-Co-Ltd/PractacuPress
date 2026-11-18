package main

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/infrastructure/db"
)

func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func openDesktopDB(t *testing.T) *db.DB {
	t.Helper()
	handle, err := db.Open(context.Background(), "sqlite",
		db.SQLiteDSN(filepath.Join(t.TempDir(), "desktop.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	return handle
}

func TestBootstrapDesktopCreatesOneSiteAndReusesIt(t *testing.T) {
	ctx := context.Background()
	handle := openDesktopDB(t)

	first, err := bootstrapDesktop(ctx, handle, silentLogger())
	require.NoError(t, err)
	require.NotEmpty(t, first)

	count, err := handle.Client.Site.Query().Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, count)

	// Restarting the launcher must not create a second site: resolution falls back to
	// the single site only when there is exactly one.
	second, err := bootstrapDesktop(ctx, handle, silentLogger())
	require.NoError(t, err)
	require.Equal(t, first, second)

	count, err = handle.Client.Site.Query().Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, count)
}

func TestBootstrapDesktopKeepsAnExistingSite(t *testing.T) {
	ctx := context.Background()
	handle := openDesktopDB(t)
	require.NoError(t, handle.Client.Schema.Create(ctx))

	row, err := handle.Client.Site.Create().SetSlug("press").SetName("My Press").Save(ctx)
	require.NoError(t, err)

	id, err := bootstrapDesktop(ctx, handle, silentLogger())
	require.NoError(t, err)
	require.Equal(t, row.ID, id, "an existing site keeps its id and name")
}

func TestBootstrapDesktopPromotesTheFirstMemberWhenNoAdminExists(t *testing.T) {
	ctx := context.Background()
	handle := openDesktopDB(t)
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("press").SetName("My Press").Save(ctx)
	require.NoError(t, err)
	user, err := handle.Client.User.Create().SetDisplayName("Solo").Save(ctx)
	require.NoError(t, err)
	member, err := handle.Client.SiteMember.Create().
		SetSiteID(siteRow.ID).
		SetUserID(user.ID).
		SetRole("member").
		Save(ctx)
	require.NoError(t, err)

	_, err = bootstrapDesktop(ctx, handle, silentLogger())
	require.NoError(t, err)

	reloaded, err := handle.Client.SiteMember.Get(ctx, member.ID)
	require.NoError(t, err)
	require.Equal(t, "platform_admin", reloaded.Role)

	// A second start must be a no-op: an existing administrator is never replaced.
	_, err = bootstrapDesktop(ctx, handle, silentLogger())
	require.NoError(t, err)
	reloaded, err = handle.Client.SiteMember.Get(ctx, member.ID)
	require.NoError(t, err)
	require.Equal(t, "platform_admin", reloaded.Role)
}
