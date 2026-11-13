package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"

	// The generated package is also named ent, so it is aliased here.
	entgen "github.com/practacu/practacu-press/apps/api/ent"
)

// SchemaVersion identifies the reviewed migration level this binary expects.
//
// It mirrors the newest file in migrations/<dialect>/; the backup manifest stores
// it so a restore can refuse a package produced by a newer schema and report when
// an older one needed the additive migration pass.
const SchemaVersion = "20261117000000"

// ErrSnapshotUnsupported means the active driver cannot be snapshotted by this
// process. SQLite has a consistent, online snapshot command; MySQL and PostgreSQL
// require their own dump tools, which this binary does not shell out to.
var ErrSnapshotUnsupported = errors.New("db: snapshot unsupported for this driver")

// Stats is the small, non sensitive inventory a restore uses to decide whether a
// database is empty and to report what came back.
type Stats struct {
	// SchemaReady reports whether the core tables exist at all.
	SchemaReady bool
	Sites       int
	Users       int
	Content     int
}

// DesignRow is one site design captured for a backup package.
//
// It is a raw row instead of an Ent model on purpose: a backup must still work
// when the database predates the newest Ent column, and a generated query selects
// every column.
type DesignRow struct {
	SiteID    string
	Name      string
	Slug      string
	Domain    string
	Revision  int
	Document  []byte
	UpdatedAt time.Time
}

// DesignRows reads every site and its saved design using only columns that have
// existed since the design table was introduced.
func (d *DB) DesignRows(ctx context.Context) ([]DesignRow, error) {
	sites, err := d.sqlDB.QueryContext(ctx,
		"SELECT id, name, slug, COALESCE(domain, '') FROM sites ORDER BY id",
	)
	if err != nil {
		return nil, err
	}
	defer sites.Close()

	bySite := make(map[string]DesignRow)
	for sites.Next() {
		var row DesignRow
		if err := sites.Scan(&row.SiteID, &row.Name, &row.Slug, &row.Domain); err != nil {
			return nil, err
		}
		bySite[row.SiteID] = row
	}
	if err := sites.Err(); err != nil {
		return nil, err
	}

	hasDesigns, err := d.tableExists(ctx, "site_customizations")
	if err != nil {
		return nil, err
	}
	if hasDesigns {
		rows, queryErr := d.sqlDB.QueryContext(ctx,
			"SELECT site_id, revision, document, updated_at FROM site_customizations ORDER BY site_id",
		)
		if queryErr != nil {
			return nil, queryErr
		}
		defer rows.Close()
		for rows.Next() {
			var siteID, document string
			var revision int
			var updatedAt time.Time
			if err := rows.Scan(&siteID, &revision, &document, &updatedAt); err != nil {
				return nil, err
			}
			row, exists := bySite[siteID]
			if !exists {
				continue
			}
			row.Revision = revision
			row.Document = []byte(document)
			row.UpdatedAt = updatedAt
			bySite[siteID] = row
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	ordered := make([]DesignRow, 0, len(bySite))
	ids := make([]string, 0, len(bySite))
	for id := range bySite {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		ordered = append(ordered, bySite[id])
	}
	return ordered, nil
}

// Snapshot writes a consistent copy of a SQLite database to dest.
//
// VACUUM INTO is the supported equivalent of the sqlite3 `.backup` command: it
// runs inside a read transaction, so a concurrent writer cannot produce a torn
// file, and the result is a normal database with no WAL sidecar. dest must not
// already exist.
func (d *DB) Snapshot(ctx context.Context, dest string) error {
	if d.driver != config.DriverSQLite {
		return fmt.Errorf("%w: driver=%s", ErrSnapshotUnsupported, d.driver)
	}
	if strings.TrimSpace(dest) == "" {
		return errors.New("db: snapshot destination is required")
	}
	if _, err := os.Stat(dest); err == nil {
		return fmt.Errorf("db: snapshot destination already exists: %s", dest)
	} else if !os.IsNotExist(err) {
		return err
	}
	if _, err := d.sqlDB.ExecContext(ctx, "VACUUM INTO ?", dest); err != nil {
		return fmt.Errorf("db: vacuum into snapshot: %w", err)
	}
	return nil
}

// Inspect returns the row counts a restore safety check needs.
//
// Only SQLite is supported because restore itself is SQLite only. A database
// file that does not exist yet, or one without the core tables, reports an empty
// schema so a first install can be restored without a confirmation prompt.
func (d *DB) Inspect(ctx context.Context) (Stats, error) {
	var stats Stats
	ready, err := d.tableExists(ctx, "sites")
	if err != nil {
		return Stats{}, err
	}
	stats.SchemaReady = ready
	if !ready {
		return stats, nil
	}

	// Every table name is a compile time constant in this file, never caller input.
	for _, probe := range []struct {
		table string
		into  *int
	}{
		{"sites", &stats.Sites},
		{"users", &stats.Users},
		{"content_items", &stats.Content},
	} {
		exists, existsErr := d.tableExists(ctx, probe.table)
		if existsErr != nil {
			return Stats{}, existsErr
		}
		if !exists {
			continue
		}
		if scanErr := d.sqlDB.QueryRowContext(
			ctx, "SELECT COUNT(*) FROM "+probe.table,
		).Scan(probe.into); scanErr != nil {
			return Stats{}, scanErr
		}
	}
	return stats, nil
}

// VerifySchema checks that the restored database carries the core tables.
//
// The additive migration pass runs before this, so a database produced by an
// older backup is repaired; a missing table after that means the file is not a
// Practacu Press database at all.
func (d *DB) VerifySchema(ctx context.Context) error {
	required := []string{
		"sites", "users", "site_members", "content_items",
		"content_revisions", "media_assets", "site_customizations",
	}
	for _, table := range required {
		exists, err := d.tableExists(ctx, table)
		if err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("db: restored database is missing table %q", table)
		}
	}
	return nil
}

func (d *DB) tableExists(ctx context.Context, table string) (bool, error) {
	var count int
	err := d.sqlDB.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
		table,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

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

// SQL exposes the underlying pool for infrastructure that must run dialect SQL
// outside Ent, such as the full text search index. Callers must not close it.
func (d *DB) SQL() *sql.DB { return d.sqlDB }

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
