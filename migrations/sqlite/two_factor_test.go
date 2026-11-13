package sqlite_migrations

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestTwoFactorMigrationCreatesAndDropsEnrollmentTables(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err := executeMigration(db, "20261116000000_two_factor.up.sql"); err != nil {
		t.Fatal(err)
	}

	// The default of a fresh enrollment is disabled and no step has been consumed.
	if _, err := db.Exec(`INSERT INTO two_factors (id, user_id, secret, created_at, updated_at)
		VALUES ('tf-1', 'user-1', 'v1:sealed', '2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	var enabled bool
	var step int64
	var confirmedAt sql.NullString
	if err := db.QueryRow(`SELECT enabled, last_used_step, confirmed_at FROM two_factors WHERE id = 'tf-1'`).
		Scan(&enabled, &step, &confirmedAt); err != nil {
		t.Fatal(err)
	}
	if enabled {
		t.Fatal("a new enrollment must start disabled")
	}
	if step != 0 {
		t.Fatalf("new enrollment last_used_step = %d, want 0", step)
	}
	if confirmedAt.Valid {
		t.Fatal("a new enrollment must not be confirmed")
	}

	// One enrollment per account.
	if _, err := db.Exec(`INSERT INTO two_factors (id, user_id, secret, created_at, updated_at)
		VALUES ('tf-2', 'user-1', 'v1:other', '2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z')`); err == nil {
		t.Fatal("two_factors allowed two rows for one account")
	}

	// Return codes are unique per account and start unused.
	if _, err := db.Exec(`INSERT INTO recovery_codes (id, user_id, code_hash, created_at)
		VALUES ('rc-1', 'user-1', 'hash-1', '2026-11-16T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO recovery_codes (id, user_id, code_hash, created_at)
		VALUES ('rc-2', 'user-1', 'hash-1', '2026-11-16T00:00:00Z')`); err == nil {
		t.Fatal("recovery_codes allowed a duplicate hash for one account")
	}

	if err := executeMigration(db, "20261116000000_two_factor.down.sql"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name IN ('two_factors', 'recovery_codes')`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("rollback left the two-factor tables behind")
	}
}
