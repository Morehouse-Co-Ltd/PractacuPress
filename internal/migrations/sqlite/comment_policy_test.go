package sqlite_migrations

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// TestCommentPolicyMigrationAddsSiteSwitches proves the two columns the community
// service reads exist after the migration, default to the documented values and can
// be rolled back.
func TestCommentPolicyMigrationAddsSiteSwitches(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.Exec("CREATE TABLE sites (id TEXT PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO sites (id) VALUES ('site_legacy')"); err != nil {
		t.Fatal(err)
	}

	if err := executeMigration(db, "20261108000000_comment_policy.up.sql"); err != nil {
		t.Fatal(err)
	}

	var enabled, review int
	if err := db.QueryRow(
		"SELECT comments_enabled, comments_require_review FROM sites WHERE id = 'site_legacy'",
	).Scan(&enabled, &review); err != nil {
		t.Fatal(err)
	}
	if enabled != 1 || review != 0 {
		t.Fatalf("defaults = (%d, %d), want (1, 0)", enabled, review)
	}

	if err := executeMigration(db, "20261108000000_comment_policy.down.sql"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("SELECT comments_enabled FROM sites LIMIT 0"); err == nil {
		t.Fatal("rollback left sites.comments_enabled behind")
	}
}
