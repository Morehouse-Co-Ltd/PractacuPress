package sqlite_migrations

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// TestContentSearchMigrationCreatesQueryableIndex proves the change set creates
// both halves of the SQLite search index and that the FTS5 half really answers a
// Chinese phrase query with a relevance order, then disappears on rollback.
//
// The rows here are inserted by hand because the migration only creates the
// schema; the API fills the index after a content row commits, and
// "go run ./cmd/searchindex -rebuild" is the backfill for older rows.
func TestContentSearchMigrationCreatesQueryableIndex(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err := executeMigration(db, "20261115000000_content_search.up.sql"); err != nil {
		t.Fatal(err)
	}

	// The base row carries the filters; the virtual table carries the tokens.
	if _, err := db.Exec(`
		INSERT INTO content_search (content_id, site_id, kind, status, access_mode, author_id, created_at_ns, tokens_title, tokens_summary, tokens_body)
		VALUES ('c_title', 'site_1', 'article', 'published', 'public', 'author_1', 100, '排 版 的 艺 术', '', '')`,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO content_search (content_id, site_id, kind, status, access_mode, author_id, created_at_ns, tokens_title, tokens_summary, tokens_body)
		VALUES ('c_body', 'site_1', 'article', 'published', 'public', 'author_1', 200, '无 关 标 题', '', '中 文 排 版 是 一 门 手 艺')`,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO content_search_fts (rowid, content_id, tokens_title, tokens_summary, tokens_body)
		SELECT rowid, content_id, tokens_title, tokens_summary, tokens_body FROM content_search`,
	); err != nil {
		t.Fatal(err)
	}

	// The documented defaults keep a partially written row readable.
	var category, tags string
	if err := db.QueryRow(
		"SELECT category_id, tags FROM content_search WHERE content_id = 'c_title'",
	).Scan(&category, &tags); err != nil {
		t.Fatal(err)
	}
	if category != "" || tags != "[]" {
		t.Fatalf("defaults = (%q, %q), want ('', '[]')", category, tags)
	}

	// A Chinese phrase is two adjacent tokens. The title hit must rank above the
	// body hit, which is what the weights (title 6, summary 3, body 1) encode.
	rows, err := db.Query(`
		SELECT content_id
		FROM content_search_fts
		WHERE content_search_fts MATCH '"排 版"'
		ORDER BY bm25(content_search_fts, 6.0, 3.0, 1.0)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	var order []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		order = append(order, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(order) != 2 {
		t.Fatalf("phrase match returned %v, want the title and body rows", order)
	}
	if order[0] != "c_title" {
		t.Fatalf("relevance order = %v, want the title match first", order)
	}

	// A term with no token is not a wildcard: FTS5 needs an expression, and the
	// application answers an empty page instead of asking for one.
	if _, err := db.Exec("SELECT 1 FROM content_search_fts WHERE content_search_fts MATCH '!!!'"); err == nil {
		t.Fatal("an unescaped operator expression must not be usable as a match query")
	}

	if err := executeMigration(db, "20261115000000_content_search.down.sql"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"content_search", "content_search_fts"} {
		if _, err := db.Exec("SELECT 1 FROM " + table + " LIMIT 0"); err == nil {
			t.Fatalf("rollback left %s behind", table)
		}
	}
}
