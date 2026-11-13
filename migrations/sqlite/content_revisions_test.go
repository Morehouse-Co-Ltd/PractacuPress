package sqlite_migrations

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestContentRevisionMigrationCreatesAndDropsHistory(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.Exec("CREATE TABLE content_items (id TEXT PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}

	if err := executeMigration(db, "20261107000000_content_revisions.up.sql"); err != nil {
		t.Fatal(err)
	}

	// The new optimistic concurrency column exists and defaults to 0 for rows
	// written before the revision feature.
	if _, err := db.Exec("INSERT INTO content_items (id) VALUES ('cnt_legacy')"); err != nil {
		t.Fatal(err)
	}
	var revision int
	if err := db.QueryRow("SELECT revision FROM content_items WHERE id = 'cnt_legacy'").Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 0 {
		t.Fatalf("legacy revision = %d, want 0", revision)
	}

	if _, err := db.Exec(`INSERT INTO content_revisions
		(id, site_id, content_id, version, editor_id, action, source_body, created_at)
		VALUES ('rev_1', 'site_1', 'cnt_1', 1, 'usr_1', 'created', '# hello', '2026-11-07T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO content_revisions
		(id, site_id, content_id, version, editor_id, action, source_body, created_at)
		VALUES ('rev_2', 'site_1', 'cnt_1', 1, 'usr_1', 'created', '# duplicate', '2026-11-07T00:00:00Z')`); err == nil {
		t.Fatal("content_revisions allowed duplicate (content_id, version)")
	}

	if err := executeMigration(db, "20261107000000_content_revisions.down.sql"); err != nil {
		t.Fatal(err)
	}
	var tableCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'content_revisions'").Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if tableCount != 0 {
		t.Fatal("rollback left content_revisions behind")
	}
	if _, err := db.Exec("SELECT revision FROM content_items LIMIT 0"); err == nil {
		t.Fatal("rollback left content_items.revision behind")
	}
}
