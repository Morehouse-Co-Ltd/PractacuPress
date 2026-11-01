package db

import (
	"context"
	"database/sql"
	"net/url"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"

	// The generated package is also named ent, so it is aliased here.
	entgen "github.com/practacu/practacu-press/apps/api/ent"
)

// Pool sizing. SQLite takes a single connection on purpose: it has one writer, and
// a larger pool converts concurrent writes into "database is locked" errors
// instead of letting them queue.
const (
	sqliteMaxOpenConns = 1
	serverMaxOpenConns = 25
	connMaxLifetime    = 30 * time.Minute
)

// DB is an opened database: the Ent client plus lifecycle helpers.
type DB struct {
	// Client is the generated Ent client. It is the only handle repositories use.
	Client *entgen.Client

	driver string
	sqlDB  *sql.DB
}

// Open connects to the database and returns a ready handle.
//
// The caller owns the handle and must Close it on shutdown. Open pings the
// database once, so a bad DSN fails at startup rather than on the first request.
func Open(ctx context.Context, driverName, dsn string) (*DB, error) {
	canonical, ok := NormalizeDriver(driverName)
	if !ok {
		return nil, apperr.New(apperr.CodeInvalidDatabaseDriver).WithDetail("driver", driverName)
	}
	if strings.TrimSpace(dsn) == "" {
		return nil, apperr.Validation("DATABASE_DSN must not be empty")
	}

	// Ent's schema tooling refuses to run with foreign keys disabled, and WAL plus a
	// busy timeout are what make concurrent writers queue instead of failing. Applying
	// them here means no caller has to remember the pragmas.
	if canonical == config.DriverSQLite {
		dsn = EnsureSQLitePragmas(dsn)
	}

	sqlDB, err := sql.Open(sqlDriverOf(canonical), dsn)
	if err != nil {
		return nil, err
	}

	if canonical == config.DriverSQLite {
		sqlDB.SetMaxOpenConns(sqliteMaxOpenConns)
	} else {
		sqlDB.SetMaxOpenConns(serverMaxOpenConns)
		sqlDB.SetMaxIdleConns(serverMaxOpenConns)
		sqlDB.SetConnMaxLifetime(connMaxLifetime)
	}

	if err := sqlDB.PingContext(ctx); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}

	client := entgen.NewClient(entgen.Driver(entsql.OpenDB(dialectOfCanonical(canonical), sqlDB)))
	return &DB{Client: client, driver: canonical, sqlDB: sqlDB}, nil
}

// ConfigurePool overrides the driver defaults after Open. Zero max-open and
// max-idle values keep the default chosen above, so a deployment that does not
// tune the pool behaves exactly as before. A zero lifetime explicitly disables
// recycling; the configuration default is 1800 seconds. SQLite reads this
// literally: setting more than one open connection with the default rollback
// journal can surface "database is locked", which is why the safe default is
// still one.
func (d *DB) ConfigurePool(maxOpen, maxIdle int, lifetime time.Duration) {
	if maxOpen > 0 {
		d.sqlDB.SetMaxOpenConns(maxOpen)
	}
	if maxIdle > 0 {
		d.sqlDB.SetMaxIdleConns(maxIdle)
	}
	if lifetime >= 0 {
		d.sqlDB.SetConnMaxLifetime(lifetime)
	}
}

// Ping reports whether the database is reachable. It backs GET /readyz.
func (d *DB) Ping(ctx context.Context) error { return d.sqlDB.PingContext(ctx) }

// Driver returns the canonical driver name.
func (d *DB) Driver() string { return d.driver }

// Dialect returns the Ent dialect constant.
func (d *DB) Dialect() string { return dialectOfCanonical(d.driver) }

// Close releases the connection pool. It is safe to call more than once.
func (d *DB) Close() error { return d.sqlDB.Close() }

// EnsureSQLitePragmas appends the pragmas this application relies on to a SQLite DSN.
//
// The server receives its DSN from the environment, not from SQLiteDSN, so this is the
// function that decides how a real deployment's database behaves. WAL matters because
// without it every reader blocks the single writer and the outbox worker's two-second
// pass contends with request handling; busy_timeout matters because without it a
// competing writer fails with "database is locked" instead of waiting for the lock.
//
// A DSN that already carries a _pragma of its own is left alone: an operator who wrote
// `_pragma=foreign_keys(0)` has made a deliberate choice, and silently appending our
// defaults to it would be both surprising and impossible to override.
func EnsureSQLitePragmas(dsn string) string {
	if strings.Contains(dsn, "_pragma") {
		return dsn
	}

	separator := "?"
	if strings.Contains(dsn, "?") {
		separator = "&"
	}

	// Order matters only for readability; foreign_keys first matches SQLiteDSN so an
	// operator comparing the two sees the same prefix.
	pragmas := []string{"foreign_keys(1)", "journal_mode(WAL)", "busy_timeout(5000)"}
	var builder strings.Builder
	builder.WriteString(dsn)
	for _, pragma := range pragmas {
		builder.WriteString(separator)
		builder.WriteString("_pragma=")
		builder.WriteString(url.QueryEscape(pragma))
		separator = "&"
	}
	return builder.String()
}

// SQLiteDSN builds a modernc/sqlite DSN with the pragmas this application relies
// on: foreign key enforcement, WAL journaling for concurrent readers, and a busy
// timeout so a competing writer waits instead of failing immediately.
func SQLiteDSN(path string) string {
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(5000)")

	target := path
	if path == ":memory:" || path == "" {
		target = ":memory:"
		return "file:" + target + "?cache=shared&" + q.Encode()
	}
	// A DSN that already carries a scheme is passed through as a file URI.
	target = strings.TrimPrefix(path, "file:")
	return "file:" + target + "?" + q.Encode()
}
