// Package migrations_test exercises the reviewed per-dialect SQL change sets.
//
// SQLite runs everywhere (an in-process driver and a throwaway file). MySQL and
// PostgreSQL need disposable databases; set PP_TEST_MYSQL_DSN and/or
// PP_TEST_POSTGRES_DSN (CI does this with service containers) or the dialect is
// skipped. The test applies the baseline schema, every .up.sql in version order,
// every .down.sql in reverse order, and asserts that the added columns, tables
// and indexes appear and disappear with them.
package migrations_test

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

const queryTimeout = 60 * time.Second

// dialect describes how to reach one supported database.
type dialect struct {
	name   string
	driver string // database/sql driver name
	env    string // variable holding a DSN; empty means "always use a temp file"
}

func (d dialect) quote(identifier string) string {
	switch d.name {
	case "mysql":
		return "`" + identifier + "`"
	case "postgres":
		return `"` + identifier + `"`
	default:
		return `"` + identifier + `"`
	}
}

func (d dialect) placeholder(index int) string {
	if d.name == "postgres" {
		return fmt.Sprintf("$%d", index)
	}
	return "?"
}

var dialects = []dialect{
	{name: "sqlite", driver: "sqlite"},
	{name: "mysql", driver: "mysql", env: "PP_TEST_MYSQL_DSN"},
	{name: "postgres", driver: "pgx", env: "PP_TEST_POSTGRES_DSN"},
}

// addedColumns is the complete set of columns introduced by the change sets.
var addedColumns = map[string][]string{
	"sites":        {"media_quota_bytes", "comments_enabled", "comments_require_review"},
	"site_members": {"media_quota_bytes"},
	"content_items": {
		"revision", "publish_at", "publish_attempts",
		"access_mode", "access_password_hash", "comment_policy",
		// The read counter of FSD A-16 (plan P0-06).
		"view_count",
	},
	"users":         {"email_verified_at"},
	"notifications": {"dedupe_key"},
}

var addedTables = []string{
	"media_quota_guards", "content_revisions", "reading_histories", "notification_preferences",
	"sensitive_words", "site_ip_rules", "site_safety_settings", "site_configs",
	"content_search", "two_factors", "recovery_codes",
	// Pending OAuth authorization requests (FSD F-05).
	"oauth_states",
}

// addedTablesByDialect holds the objects only one engine needs. SQLite keeps the
// token stream in an FTS5 virtual table (visible in sqlite_master as a table);
// MySQL, MariaDB and PostgreSQL index the base table directly.
var addedTablesByDialect = map[string][]string{
	"sqlite": {"content_search_fts"},
}

var addedIndexes = []string{
	"auditlog_action_created_at",
	"readinghistory_user_id_target_type_target_id",
	"readinghistory_site_id_user_id_last_viewed_at",
	"notification_site_id_user_id_dedupe_key_created_at",
	"notificationpreference_site_id_user_id",
	"sensitiveword_site_id_word",
	"siteiprule_site_id_kind_value",
	"sitesafetysetting_site_id",
	"siteconfig_site_id",
	"contentitem_publish_at",
	"content_search_site",
	// The popular leaderboard reads one site's published rows by view count.
	"contentitem_site_id_status_view_count",
	"two_factors_user_id_key",
	"twofactor_enabled",
	"recoverycode_user_id_code_hash",
	"recoverycode_user_id_used_at",
	// The OAuth state sweeper deletes expired rows by this column.
	"oauthstate_expires_at",
}

// addedIndexesByDialect holds the engine specific search index: FULLTEXT with the
// ngram parser on MySQL/MariaDB, GIN over the generated tsvector on PostgreSQL.
var addedIndexesByDialect = map[string][]string{
	"mysql":    {"content_search_fulltext"},
	"postgres": {"content_search_vector"},
}

// TestMigrationPairs is the dependency-free gate: every up script has a matching
// down script, versions sort deterministically, and the up scripts stay additive.
func TestMigrationPairs(t *testing.T) {
	root := repoRoot(t)
	for _, name := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(name, func(t *testing.T) {
			ups, downs := migrationFiles(t, filepath.Join(root, "migrations", name))
			if len(ups) == 0 {
				t.Fatalf("no .up.sql files under migrations/%s", name)
			}
			if len(ups) != len(downs) {
				t.Fatalf("migrations/%s has %d up and %d down scripts", name, len(ups), len(downs))
			}

			for _, up := range ups {
				base := strings.TrimSuffix(up, ".up.sql")
				if !contains(downs, base+".down.sql") {
					t.Errorf("migrations/%s/%s has no matching .down.sql", name, up)
					continue
				}
				upSQL := readFile(t, filepath.Join(root, "migrations", name, up))
				downSQL := readFile(t, filepath.Join(root, "migrations", name, base+".down.sql"))
				upper := strings.ToUpper(upSQL)
				if !strings.Contains(upper, "ALTER TABLE") && !strings.Contains(upper, "CREATE TABLE") && !strings.Contains(upper, "CREATE INDEX") {
					t.Errorf("migrations/%s/%s does not change the schema", name, up)
				}
				for _, forbidden := range []string{"DROP TABLE", "DROP COLUMN", "DROP INDEX"} {
					if strings.Contains(upper, forbidden) {
						t.Errorf("migrations/%s/%s is not additive: contains %q", name, up, forbidden)
					}
				}
				if !strings.Contains(strings.ToUpper(downSQL), "DROP") {
					t.Errorf("migrations/%s/%s.down.sql does not roll anything back", name, base)
				}
			}
		})
	}
}

// TestMigrationScriptsRoundTrip runs the scripts against a real database.
func TestMigrationScriptsRoundTrip(t *testing.T) {
	root := repoRoot(t)
	for _, spec := range dialects {
		spec := spec
		t.Run(spec.name, func(t *testing.T) {
			dsn := os.Getenv(spec.env)
			if spec.driver == "sqlite" {
				dsn = filepath.Join(t.TempDir(), "migrations.db")
			} else if dsn == "" {
				t.Skipf("%s is not set; start a disposable %s and export it to run this dialect", spec.env, spec.name)
			} else if !strings.Contains(strings.ToLower(dsn), "test") && os.Getenv("PP_TEST_ALLOW_DESTRUCTIVE") != "1" {
				// The test creates and drops tables. Refuse an obvious production DSN.
				t.Fatalf("%s must point at a disposable database whose name contains \"test\"; set PP_TEST_ALLOW_DESTRUCTIVE=1 only if you are certain", spec.env)
			}

			h := openHarness(t, root, spec, dsn)
			// Defers run LIFO: drop the smoke schema first, then close the handle.
			defer h.close(t)
			defer h.dropEverything(t)

			// A previous interrupted run must not decide the result.
			h.dropEverything(t)

			h.execFile(t, filepath.Join(root, "tests", "fixtures", "migrations", spec.name, "baseline.sql"))

			ups, _ := migrationFiles(t, filepath.Join(root, "migrations", spec.name))
			for _, file := range ups {
				h.execFile(t, filepath.Join(root, "migrations", spec.name, file))
			}
			h.assertAddedObjectsExist(t)

			// Roll back in the reverse order the migrations were applied.
			for i := len(ups) - 1; i >= 0; i-- {
				base := strings.TrimSuffix(ups[i], ".up.sql")
				h.execFile(t, filepath.Join(root, "migrations", spec.name, base+".down.sql"))
			}
			h.assertAddedObjectsGone(t)
		})
	}
}

type harness struct {
	t       *testing.T
	db      *sql.DB
	dialect dialect
	root    string
}

func openHarness(t *testing.T, root string, spec dialect, dsn string) *harness {
	t.Helper()
	db, err := sql.Open(spec.driver, dsn)
	if err != nil {
		t.Fatalf("open %s: %v", spec.name, err)
	}
	db.SetMaxOpenConns(2)
	db.SetConnMaxLifetime(time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		t.Fatalf("ping %s: %v (is the database up?)", spec.name, err)
	}
	return &harness{t: t, db: db, dialect: spec, root: root}
}

func (h *harness) close(t *testing.T) {
	t.Helper()
	if err := h.db.Close(); err != nil {
		t.Logf("close %s: %v", h.dialect.name, err)
	}
}

func (h *harness) exec(query string, args ...any) error {
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	_, err := h.db.ExecContext(ctx, query, args...)
	return err
}

func (h *harness) count(query string, args ...any) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	var n int
	if err := h.db.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

// execFile applies one reviewed SQL file, statement by statement. The scripts are
// plain semicolon-separated SQL with full-line -- comments, which this splitter
// understands; keeping them single-statement lets every driver run without
// multiStatements / simple-protocol options.
func (h *harness) execFile(t *testing.T, path string) {
	t.Helper()
	for _, statement := range splitStatements(readFile(t, path)) {
		if err := h.exec(statement); err != nil {
			t.Fatalf("%s: apply %q: %v", filepath.Base(path), statement, err)
		}
	}
}

func (h *harness) dropEverything(t *testing.T) {
	t.Helper()
	// Dependants first; the smoke schema has no foreign keys but keeping the order
	// stable makes failures easier to read.
	tables := []string{
		// The search index first: SQLite's FTS5 virtual table owns shadow tables.
		"content_search_fts", "content_search",
		"oauth_states", "recovery_codes", "two_factors",
		"notification_preferences", "notifications",
		"reading_histories", "content_revisions", "media_quota_guards",
		"site_configs", "site_safety_settings", "site_ip_rules", "sensitive_words",
		"content_items", "site_members", "sites",
		"audit_logs", "user_identities", "users",
	}
	for _, table := range tables {
		var statement string
		switch h.dialect.name {
		case "postgres":
			statement = fmt.Sprintf("DROP TABLE IF EXISTS %s CASCADE", h.dialect.quote(table))
		case "mysql":
			statement = fmt.Sprintf("DROP TABLE IF EXISTS %s", h.dialect.quote(table))
		default:
			statement = fmt.Sprintf("DROP TABLE IF EXISTS %s", h.dialect.quote(table))
		}
		if err := h.exec(statement); err != nil {
			t.Fatalf("%s: drop %s: %v", h.dialect.name, table, err)
		}
	}
}

func (h *harness) assertAddedObjectsExist(t *testing.T) {
	t.Helper()
	for table, columns := range addedColumns {
		for _, column := range columns {
			if !h.columnExists(t, table, column) {
				t.Errorf("%s: column %s.%s was not created", h.dialect.name, table, column)
			}
		}
	}
	tables := append(append([]string(nil), addedTables...), addedTablesByDialect[h.dialect.name]...)
	for _, table := range tables {
		if !h.tableExists(t, table) {
			t.Errorf("%s: table %s was not created", h.dialect.name, table)
		}
	}
	indexes := append(append([]string(nil), addedIndexes...), addedIndexesByDialect[h.dialect.name]...)
	for _, index := range indexes {
		if !h.indexExists(t, index) {
			t.Errorf("%s: index %s was not created", h.dialect.name, index)
		}
	}
}

func (h *harness) assertAddedObjectsGone(t *testing.T) {
	t.Helper()
	for table, columns := range addedColumns {
		for _, column := range columns {
			if h.columnExists(t, table, column) {
				t.Errorf("%s: rollback left column %s.%s behind", h.dialect.name, table, column)
			}
		}
	}
	tables := append(append([]string(nil), addedTables...), addedTablesByDialect[h.dialect.name]...)
	for _, table := range tables {
		if h.tableExists(t, table) {
			t.Errorf("%s: rollback left table %s behind", h.dialect.name, table)
		}
	}
	indexes := append(append([]string(nil), addedIndexes...), addedIndexesByDialect[h.dialect.name]...)
	for _, index := range indexes {
		if h.indexExists(t, index) {
			t.Errorf("%s: rollback left index %s behind", h.dialect.name, index)
		}
	}
}

func (h *harness) tableExists(t *testing.T, table string) bool {
	t.Helper()
	var query string
	var args []any
	switch h.dialect.name {
	case "mysql":
		query = "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?"
		args = []any{table}
	case "postgres":
		query = "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1"
		args = []any{table}
	default:
		query = "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?"
		args = []any{table}
	}
	n, err := h.count(query, args...)
	if err != nil {
		t.Fatalf("%s: table %s: %v", h.dialect.name, table, err)
	}
	return n > 0
}

func (h *harness) columnExists(t *testing.T, table, column string) bool {
	t.Helper()
	if h.dialect.name == "sqlite" {
		rows, err := h.db.Query(fmt.Sprintf("PRAGMA table_info(%s)", h.dialect.quote(table)))
		if err != nil {
			t.Fatalf("sqlite: table info %s: %v", table, err)
		}
		defer rows.Close()
		for rows.Next() {
			var (
				cid     int
				name    string
				typ     string
				notNull int
				dflt    sql.NullString
				pk      int
			)
			if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
				t.Fatalf("sqlite: scan table info %s: %v", table, err)
			}
			if name == column {
				return true
			}
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("sqlite: table info %s: %v", table, err)
		}
		return false
	}

	var query string
	var args []any
	if h.dialect.name == "mysql" {
		query = "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?"
		args = []any{table, column}
	} else {
		query = "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2"
		args = []any{table, column}
	}
	n, err := h.count(query, args...)
	if err != nil {
		t.Fatalf("%s: column %s.%s: %v", h.dialect.name, table, column, err)
	}
	return n > 0
}

func (h *harness) indexExists(t *testing.T, index string) bool {
	t.Helper()
	var query string
	var args []any
	switch h.dialect.name {
	case "mysql":
		query = "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name = ?"
		args = []any{index}
	case "postgres":
		query = "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1"
		args = []any{index}
	default:
		query = "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?"
		args = []any{index}
	}
	n, err := h.count(query, args...)
	if err != nil {
		t.Fatalf("%s: index %s: %v", h.dialect.name, index, err)
	}
	return n > 0
}

// migrationFiles returns up scripts sorted ascending and down scripts sorted
// descending (the order a rollback must use).
func migrationFiles(t *testing.T, dir string) (ups, downs []string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		switch {
		case strings.HasSuffix(entry.Name(), ".up.sql"):
			ups = append(ups, entry.Name())
		case strings.HasSuffix(entry.Name(), ".down.sql"):
			downs = append(downs, entry.Name())
		}
	}
	sort.Strings(ups)
	sort.Sort(sort.Reverse(sort.StringSlice(downs)))
	return ups, downs
}

func splitStatements(script string) []string {
	var clean strings.Builder
	for _, line := range strings.Split(script, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		clean.WriteString(line)
		clean.WriteString("\n")
	}
	var statements []string
	for _, part := range strings.Split(clean.String(), ";") {
		if statement := strings.TrimSpace(part); statement != "" {
			statements = append(statements, statement)
		}
	}
	return statements
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the test file")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}
