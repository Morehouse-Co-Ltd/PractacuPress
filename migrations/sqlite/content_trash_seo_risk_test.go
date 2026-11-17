package sqlite_migrations

import (
	"database/sql"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// columnInfo is one row of PRAGMA table_info: the declared type plus the parts of the
// definition this change set has to get right (nullability and default value).
type columnInfo struct {
	dataType   string
	notNull    bool
	defaultSQL sql.NullString
}

// columnExpectation is what the change set promises for one of the new columns.
type columnExpectation struct {
	table      string
	column     string
	dataType   string
	notNull    bool
	hasDefault bool
	defaultV   string
}

// TestContentTrashSeoRiskMigration proves the Beta 1.2 change set adds the recycle
// bin marker, the per item SEO and cover columns, the media file name and the comment
// risk columns with the documented nullability and defaults, that the
// (site_id, deleted_at) index exists, that a trashed row round-trips, and that the
// paired rollback removes every new column and index without touching the rows that
// were already there.
func TestContentTrashSeoRiskMigration(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// One connection: an in-memory SQLite database is per connection, so a second
	// pooled connection would silently see an empty schema.
	db.SetMaxOpenConns(1)

	for _, statement := range []string{
		"CREATE TABLE content_items (id TEXT PRIMARY KEY, site_id TEXT NOT NULL)",
		"CREATE TABLE media_assets (id TEXT PRIMARY KEY)",
		"CREATE TABLE comments (id TEXT PRIMARY KEY)",
		// Rows written before the change set: every new column has to default, so an
		// existing deployment keeps working without a backfill.
		"INSERT INTO content_items (id, site_id) VALUES ('cnt_legacy', 'site_1')",
		"INSERT INTO media_assets (id) VALUES ('asset_legacy')",
		"INSERT INTO comments (id) VALUES ('cmt_legacy')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	if err := executeMigration(db, "20261120000000_content_trash_seo_risk.up.sql"); err != nil {
		t.Fatal(err)
	}

	expectations := []columnExpectation{
		{"content_items", "deleted_at", "DATETIME", false, false, ""},
		{"content_items", "seo_title", "VARCHAR(200)", true, true, ""},
		{"content_items", "seo_description", "VARCHAR(500)", true, true, ""},
		{"content_items", "seo_keywords", "VARCHAR(500)", true, true, ""},
		{"content_items", "canonical_url", "VARCHAR(500)", true, true, ""},
		{"content_items", "og_image", "TEXT", true, true, ""},
		{"content_items", "robots", "VARCHAR(16)", true, true, ""},
		{"content_items", "cover_url", "TEXT", true, true, ""},
		{"content_items", "cover_alt", "VARCHAR(200)", true, true, ""},
		{"content_items", "cover_position", "VARCHAR(16)", true, true, "center"},
		{"content_items", "cover_hidden", "INTEGER", true, true, "0"},
		// media_assets.file_name keeps the name the uploader used.
		{"media_assets", "file_name", "VARCHAR(200)", true, true, ""},
		// comments carries the server side moderation ranking.
		{"comments", "risk_score", "INTEGER", true, true, "0"},
		{"comments", "risk_flags", "TEXT", true, true, "[]"},
	}

	tables := map[string]map[string]columnInfo{}
	for _, want := range expectations {
		columns, seen := tables[want.table]
		if !seen {
			columns = columnsOf(t, db, want.table)
			tables[want.table] = columns
		}
		info, ok := columns[want.column]
		if !ok {
			t.Fatalf("change set left %s.%s out", want.table, want.column)
		}
		if info.dataType != want.dataType {
			t.Fatalf("%s.%s type = %q, want %q", want.table, want.column, info.dataType, want.dataType)
		}
		if info.notNull != want.notNull {
			t.Fatalf("%s.%s NOT NULL = %v, want %v", want.table, want.column, info.notNull, want.notNull)
		}
		gotDefault, hasDefault := normaliseDefault(info.defaultSQL)
		if hasDefault != want.hasDefault || gotDefault != want.defaultV {
			t.Fatalf("%s.%s default = (%q, %v), want (%q, %v)",
				want.table, want.column, gotDefault, hasDefault, want.defaultV, want.hasDefault)
		}
	}

	// The existing columns survive the additive change set.
	for _, column := range []string{"id", "site_id"} {
		if _, ok := tables["content_items"][column]; !ok {
			t.Fatalf("change set dropped content_items.%s", column)
		}
	}

	// The recycle bin query is "one site's trashed rows newest first", which is what
	// this index answers, and every other query adds "deleted_at IS NULL" to an
	// existing site predicate.
	if got := indexColumns(t, db, "contentitem_site_id_deleted_at", "content_items"); len(got) != 2 ||
		got[0] != "site_id" || got[1] != "deleted_at" {
		t.Fatalf("index contentitem_site_id_deleted_at columns = %v, want [site_id deleted_at]", got)
	}

	// Legacy rows adopt the documented defaults: not trashed, nothing inherited overridden,
	// no cover configured and an unranked comment whose flag list is empty.
	var (
		legacyDeletedAt sql.NullString
		seoTitle        string
		ogImage         string
		robots          string
		coverURL        string
		coverPosition   string
		coverHidden     int
	)
	if err := db.QueryRow(`SELECT deleted_at, seo_title, og_image, robots, cover_url,
		cover_position, cover_hidden FROM content_items WHERE id = 'cnt_legacy'`).
		Scan(&legacyDeletedAt, &seoTitle, &ogImage, &robots, &coverURL, &coverPosition, &coverHidden); err != nil {
		t.Fatal(err)
	}
	if legacyDeletedAt.Valid || seoTitle != "" || ogImage != "" || robots != "" || coverURL != "" ||
		coverPosition != "center" || coverHidden != 0 {
		t.Fatalf("legacy row defaults = (%v, %q, %q, %q, %q, %q, %d), want (NULL, '', '', '', '', 'center', 0)",
			legacyDeletedAt, seoTitle, ogImage, robots, coverURL, coverPosition, coverHidden)
	}
	var fileName string
	if err := db.QueryRow("SELECT file_name FROM media_assets WHERE id = 'asset_legacy'").Scan(&fileName); err != nil {
		t.Fatal(err)
	}
	if fileName != "" {
		t.Fatalf("legacy asset file_name = %q, want empty", fileName)
	}
	var riskScore int
	var riskFlags string
	if err := db.QueryRow("SELECT risk_score, risk_flags FROM comments WHERE id = 'cmt_legacy'").
		Scan(&riskScore, &riskFlags); err != nil {
		t.Fatal(err)
	}
	if riskScore != 0 || riskFlags != "[]" {
		t.Fatalf("legacy comment risk = (%d, %q), want (0, \"[]\")", riskScore, riskFlags)
	}

	// A soft delete is one UPDATE of one column, and the row stays readable.
	if _, err := db.Exec(`UPDATE content_items
		SET deleted_at = '2026-11-20T10:00:00Z', seo_title = '回收站', robots = 'noindex'
		WHERE id = 'cnt_legacy'`); err != nil {
		t.Fatal(err)
	}
	var (
		trashedAt sql.NullString
		trashSeo  string
		trashNoIx string
	)
	if err := db.QueryRow(`SELECT deleted_at, seo_title, robots FROM content_items
		WHERE id = 'cnt_legacy'`).Scan(&trashedAt, &trashSeo, &trashNoIx); err != nil {
		t.Fatal(err)
	}
	if !trashedAt.Valid || trashedAt.String != "2026-11-20T10:00:00Z" ||
		trashSeo != "回收站" || trashNoIx != "noindex" {
		t.Fatalf("trashed row = (%v, %q, %q)", trashedAt, trashSeo, trashNoIx)
	}
	var (
		liveCount    int
		trashedCount int
	)
	if err := db.QueryRow("SELECT COUNT(*) FROM content_items WHERE deleted_at IS NULL").Scan(&liveCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM content_items WHERE deleted_at IS NOT NULL").Scan(&trashedCount); err != nil {
		t.Fatal(err)
	}
	if liveCount != 0 || trashedCount != 1 {
		t.Fatalf("recycle bin split = (%d live, %d trashed), want (0, 1)", liveCount, trashedCount)
	}

	// og_image and cover_url hold a data URL, which is why they are TEXT. SQLite does
	// not enforce a VARCHAR length, so this pins the intent of the column type rather
	// than an engine behaviour MySQL would enforce.
	dataURL := "data:image/png;base64," + strings.Repeat("A", 5000)
	if _, err := db.Exec("UPDATE content_items SET og_image = ?, cover_url = ? WHERE id = 'cnt_legacy'",
		dataURL, dataURL); err != nil {
		t.Fatal(err)
	}
	var storedLength int
	if err := db.QueryRow("SELECT length(og_image) FROM content_items WHERE id = 'cnt_legacy'").
		Scan(&storedLength); err != nil {
		t.Fatal(err)
	}
	if storedLength != len(dataURL) {
		t.Fatalf("stored data URL length = %d, want %d", storedLength, len(dataURL))
	}

	// A row written without the new comment columns still lands on the documented
	// ranking defaults, so the moderator queue can rank it.
	if _, err := db.Exec("INSERT INTO comments (id) VALUES ('cmt_new')"); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT risk_score, risk_flags FROM comments WHERE id = 'cmt_new'").
		Scan(&riskScore, &riskFlags); err != nil {
		t.Fatal(err)
	}
	if riskScore != 0 || riskFlags != "[]" {
		t.Fatalf("new comment risk = (%d, %q), want (0, \"[]\")", riskScore, riskFlags)
	}

	// Rollback: drop the index first (SQLite refuses to drop an indexed column), then
	// the columns. SQLite has supported ADD COLUMN forever and DROP COLUMN since 3.35,
	// and modernc.org/sqlite bundles a far newer engine, so the down script is
	// exercised here instead of being skipped.
	if err := executeMigration(db, "20261120000000_content_trash_seo_risk.down.sql"); err != nil {
		t.Fatalf("rollback failed: %v", err)
	}
	for _, want := range expectations {
		if _, err := db.Exec("SELECT " + want.column + " FROM " + want.table + " LIMIT 0"); err == nil {
			t.Fatalf("rollback left %s.%s behind", want.table, want.column)
		}
	}
	var indexCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'index' AND name = 'contentitem_site_id_deleted_at'`).Scan(&indexCount); err != nil {
		t.Fatal(err)
	}
	if indexCount != 0 {
		t.Fatal("rollback left contentitem_site_id_deleted_at behind")
	}

	// The additive change set only ever added columns, so the rows survive rollback.
	for table, want := range map[string]int{"content_items": 1, "media_assets": 1, "comments": 2} {
		var got int
		if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("%s kept %d rows after rollback, want %d", table, got, want)
		}
	}
	var siteID string
	if err := db.QueryRow("SELECT site_id FROM content_items WHERE id = 'cnt_legacy'").Scan(&siteID); err != nil {
		t.Fatalf("rollback damaged the content_items row: %v", err)
	}
	if siteID != "site_1" {
		t.Fatalf("content_items.site_id = %q after rollback, want site_1", siteID)
	}
}

// columnsOf returns PRAGMA table_info for one table, keyed by column name.
func columnsOf(t *testing.T, db *sql.DB, table string) map[string]columnInfo {
	t.Helper()
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	columns := map[string]columnInfo{}
	for rows.Next() {
		var (
			position int
			name     string
			info     columnInfo
			primary  int
		)
		if err := rows.Scan(&position, &name, &info.dataType, &info.notNull, &info.defaultSQL, &primary); err != nil {
			t.Fatal(err)
		}
		columns[name] = info
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return columns
}

// normaliseDefault turns the SQL literal PRAGMA table_info reports into the value it
// stands for: an empty string default reads back as a pair of single quotes, the empty
// JSON array as a quoted bracket pair, and a numeric default as its digits. The second
// result is false when the column has no default at all.
func normaliseDefault(raw sql.NullString) (string, bool) {
	if !raw.Valid {
		return "", false
	}
	value := raw.String
	if len(value) >= 2 && strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'") {
		value = strings.ReplaceAll(value[1:len(value)-1], "''", "'")
	}
	return value, true
}

// indexColumns returns the indexed columns of a named index in order, and fails the
// test when the index is missing or belongs to another table.
func indexColumns(t *testing.T, db *sql.DB, index, table string) []string {
	t.Helper()
	var owner string
	if err := db.QueryRow(`SELECT tbl_name FROM sqlite_master
		WHERE type = 'index' AND name = ?`, index).Scan(&owner); err != nil {
		t.Fatalf("index %s missing: %v", index, err)
	}
	if owner != table {
		t.Fatalf("index %s belongs to %s, want %s", index, owner, table)
	}

	rows, err := db.Query("PRAGMA index_info(" + index + ")")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	var columns []string
	for rows.Next() {
		var (
			sequence int
			position int
			name     string
		)
		if err := rows.Scan(&sequence, &position, &name); err != nil {
			t.Fatal(err)
		}
		columns = append(columns, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return columns
}
