package sqlite_migrations

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// TestContentSafetyMigrationCreatesTables proves the three content safety tables
// exist after the migration, carry the documented defaults and are removed by the
// paired rollback.
func TestContentSafetyMigrationCreatesTables(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err := executeMigration(db, "20261112000000_content_safety.up.sql"); err != nil {
		t.Fatal(err)
	}

	if _, err := db.Exec(
		"INSERT INTO sensitive_words (id, site_id, word, created_at, updated_at) VALUES ('w1', 'site_1', 'forbid', '2026-11-07', '2026-11-07')",
	); err != nil {
		t.Fatal(err)
	}
	var mode, replacement, enabled string
	if err := db.QueryRow(
		"SELECT mode, replacement, enabled FROM sensitive_words WHERE id = 'w1'",
	).Scan(&mode, &replacement, &enabled); err != nil {
		t.Fatal(err)
	}
	if mode != "reject" || replacement != "***" || enabled != "1" {
		t.Fatalf("sensitive word defaults = (%q, %q, %q), want (reject, ***, 1)", mode, replacement, enabled)
	}

	if _, err := db.Exec(
		"INSERT INTO site_safety_settings (id, site_id, created_at, updated_at) VALUES ('s1', 'site_1', '2026-11-07', '2026-11-07')",
	); err != nil {
		t.Fatal(err)
	}
	var userLimit, ipLimit, window int
	if err := db.QueryRow(
		"SELECT comment_user_limit, comment_ip_limit, comment_window_seconds FROM site_safety_settings WHERE id = 's1'",
	).Scan(&userLimit, &ipLimit, &window); err != nil {
		t.Fatal(err)
	}
	if userLimit != 5 || ipLimit != 10 || window != 60 {
		t.Fatalf("rate defaults = (%d, %d, %d), want (5, 10, 60)", userLimit, ipLimit, window)
	}

	if _, err := db.Exec(
		"INSERT INTO site_ip_rules (id, site_id, kind, value, created_at) VALUES ('r1', 'site_1', 'deny', '203.0.113.0/24', '2026-11-07')",
	); err != nil {
		t.Fatal(err)
	}

	if err := executeMigration(db, "20261112000000_content_safety.down.sql"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"sensitive_words", "site_ip_rules", "site_safety_settings"} {
		if _, err := db.Exec("SELECT 1 FROM " + table + " LIMIT 0"); err == nil {
			t.Fatalf("rollback left %s behind", table)
		}
	}
}
