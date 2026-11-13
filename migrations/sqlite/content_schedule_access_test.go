package sqlite_migrations

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// TestContentScheduleAccessMigration proves the scheduled publication and per item
// access columns exist after the change set, default to the documented values for a
// legacy row and can be rolled back.
func TestContentScheduleAccessMigration(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.Exec("CREATE TABLE content_items (id TEXT PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO content_items (id) VALUES ('cnt_legacy')"); err != nil {
		t.Fatal(err)
	}

	if err := executeMigration(db, "20261113000000_content_schedule_access.up.sql"); err != nil {
		t.Fatal(err)
	}

	var (
		publishAt       sql.NullString
		publishAttempts int
		accessMode      string
		passwordHash    sql.NullString
		commentPolicy   string
	)
	if err := db.QueryRow(`SELECT publish_at, publish_attempts, access_mode,
		access_password_hash, comment_policy FROM content_items WHERE id = 'cnt_legacy'`).
		Scan(&publishAt, &publishAttempts, &accessMode, &passwordHash, &commentPolicy); err != nil {
		t.Fatal(err)
	}
	if publishAt.Valid || publishAttempts != 0 {
		t.Fatalf("schedule defaults = (%v, %d), want (NULL, 0)", publishAt, publishAttempts)
	}
	if accessMode != "public" || passwordHash.Valid || commentPolicy != "inherit" {
		t.Fatalf("access defaults = (%q, %v, %q), want (public, NULL, inherit)",
			accessMode, passwordHash, commentPolicy)
	}

	if err := executeMigration(db, "20261113000000_content_schedule_access.down.sql"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("SELECT publish_at FROM content_items LIMIT 0"); err == nil {
		t.Fatal("rollback left content_items.publish_at behind")
	}
}
