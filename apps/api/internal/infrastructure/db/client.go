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

// Ping reports whether the database is reachable. It backs GET /readyz.
func (d *DB) Ping(ctx context.Context) error { return d.sqlDB.PingContext(ctx) }

// Driver returns the canonical driver name.
func (d *DB) Driver() string { return d.driver }

// Dialect returns the Ent dialect constant.
func (d *DB) Dialect() string { return dialectOfCanonical(d.driver) }

// Close releases the connection pool. It is safe to call more than once.
func (d *DB) Close() error { return d.sqlDB.Close() }

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

