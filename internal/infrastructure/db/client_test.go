package db

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	"entgo.io/ent/dialect/sql/schema"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/errors"
)

func TestSupportedDrivers(t *testing.T) {
	for _, name := range []string{"sqlite", "mysql", "postgres", "postgresql", "pg", " PostgreSQL ", "MYSQL"} {
		require.True(t, IsSupportedDriver(name), name)
	}
	for _, name := range []string{"oracle", "sqlserver", "", "   "} {
		require.False(t, IsSupportedDriver(name), name)
	}
}

func TestNormalizeDriver(t *testing.T) {
	got, ok := NormalizeDriver(" PostgreSQL ")
	require.True(t, ok)
	require.Equal(t, "postgres", got)

	_, ok = NormalizeDriver("oracle")
	require.False(t, ok)
}

func TestDialectOf(t *testing.T) {
	cases := map[string]string{
		"sqlite":     dialect.SQLite,
		"MySQL":      dialect.MySQL,
		"postgresql": dialect.Postgres,
	}
	for in, want := range cases {
		got, ok := DialectOf(in)
		require.True(t, ok, in)
		require.Equal(t, want, got, in)
	}

	_, ok := DialectOf("oracle")
	require.False(t, ok)
}

func TestOpenRejectsUnknownDriver(t *testing.T) {
	_, err := Open(context.Background(), "oracle", "whatever")
	require.Error(t, err)
	require.True(t, apperr.Is(err, apperr.CodeInvalidDatabaseDriver))
}

func TestOpenRejectsEmptyDSN(t *testing.T) {
	_, err := Open(context.Background(), "sqlite", "  ")
	require.Error(t, err)
	require.True(t, apperr.Is(err, apperr.CodeValidationFailed))
}

func TestSQLiteDSNCarriesPragmas(t *testing.T) {
	dsn := SQLiteDSN(filepath.Join("data", "app.db"))
	require.Contains(t, dsn, "file:")
	require.Contains(t, dsn, "foreign_keys")
	require.Contains(t, dsn, "journal_mode")
	require.Contains(t, dsn, "busy_timeout")

	mem := SQLiteDSN(":memory:")
	require.Contains(t, mem, "cache=shared")
}

// TestOpenSQLiteAndCreateSchema is the end to end proof that the portable model
// actually materialises on a real database.
func TestOpenSQLiteAndCreateSchema(t *testing.T) {
	ctx := context.Background()
	dsn := SQLiteDSN(filepath.Join(t.TempDir(), "test.db"))

	handle, err := Open(ctx, "sqlite", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })

	require.Equal(t, "sqlite", handle.Driver())
	require.Equal(t, dialect.SQLite, handle.Dialect())
	require.NoError(t, handle.Ping(ctx))

	require.NoError(t, handle.Client.Schema.Create(ctx,
		schema.WithDropColumn(false),
		schema.WithDropIndex(false),
	))

	// Round trip: the generated client must write and read back.
	created, err := handle.Client.User.Create().
		SetDisplayName("alice").
		Save(ctx)
	require.NoError(t, err)
	require.NotEmpty(t, created.ID, "UUIDv7 default did not run")
	require.Equal(t, "active", created.Status)

	read, err := handle.Client.User.Get(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, "alice", read.DisplayName)
	require.False(t, read.CreatedAt.IsZero())
}

func TestConfigurePoolOverridesMaxOpen(t *testing.T) {
	ctx := context.Background()
	handle, err := Open(ctx, "sqlite", SQLiteDSN(filepath.Join(t.TempDir(), "pool.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })

	handle.ConfigurePool(3, 2, time.Minute)
	require.Equal(t, 3, handle.sqlDB.Stats().MaxOpenConnections)

	// 0 keeps the current setting for open/idle; only explicit values override.
	handle.ConfigurePool(0, 0, 0)
	require.Equal(t, 3, handle.sqlDB.Stats().MaxOpenConnections)
}

// TestSchemaIsIdempotent guards the migration command: applying the schema twice
// must succeed, because deploy scripts may re-run it.
func TestSchemaIsIdempotent(t *testing.T) {
	ctx := context.Background()
	handle, err := Open(ctx, "sqlite", SQLiteDSN(filepath.Join(t.TempDir(), "idem.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })

	for i := 0; i < 2; i++ {
		require.NoError(t, handle.Client.Schema.Create(ctx,
			schema.WithDropColumn(false),
			schema.WithDropIndex(false),
		))
	}
}

// TestUniqueSiteMembership proves the schema rejects a duplicate membership, which
// is what makes "join a site twice" idempotent at the storage level.
func TestUniqueSiteMembership(t *testing.T) {
	ctx := context.Background()
	handle, err := Open(ctx, "sqlite", SQLiteDSN(filepath.Join(t.TempDir(), "uniq.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	site, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)
	user, err := handle.Client.User.Create().SetDisplayName("bob").Save(ctx)
	require.NoError(t, err)

	_, err = handle.Client.SiteMember.Create().
		SetSiteID(site.ID).SetUserID(user.ID).Save(ctx)
	require.NoError(t, err)

	_, err = handle.Client.SiteMember.Create().
		SetSiteID(site.ID).SetUserID(user.ID).Save(ctx)
	require.Error(t, err, "duplicate site membership must be rejected")
}

// TestOpenSQLiteAppliesRequiredPragmas proves callers do not have to remember them:
// Ent refuses to create a schema when foreign keys are disabled.
func TestOpenSQLiteAppliesRequiredPragmas(t *testing.T) {
	ctx := context.Background()
	plain := "file:" + filepath.Join(t.TempDir(), "plain.db")

	handle, err := Open(ctx, "sqlite", plain)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })

	require.NoError(t, handle.Client.Schema.Create(ctx),
		"schema creation requires foreign keys to be on")

	var enabled int
	row := handle.sqlDB.QueryRowContext(ctx, "PRAGMA foreign_keys")
	require.NoError(t, row.Scan(&enabled))
	require.Equal(t, 1, enabled)
}

func TestEnsureSQLitePragmasLeavesExplicitDSNAlone(t *testing.T) {
	explicit := "file:x.db?_pragma=foreign_keys(0)"
	require.Equal(t, explicit, EnsureSQLitePragmas(explicit))
	require.Contains(t, EnsureSQLitePragmas("file:x.db"), "foreign_keys")
	require.Contains(t, EnsureSQLitePragmas("file:x.db?cache=shared"), "&_pragma=foreign_keys")
}
