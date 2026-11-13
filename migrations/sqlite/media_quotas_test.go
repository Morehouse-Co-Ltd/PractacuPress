package sqlite_migrations

import (
	"database/sql"
	"os"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestMediaQuotaMigrationCreatesAndDropsReservationGuard(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	for _, statement := range []string{
		"CREATE TABLE sites (id TEXT PRIMARY KEY)",
		"CREATE TABLE site_members (id TEXT PRIMARY KEY)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	if err := executeMigration(db, "20261104000000_media_quotas.up.sql"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"sites", "site_members"} {
		if _, err := db.Exec("SELECT media_quota_bytes FROM " + table + " LIMIT 0"); err != nil {
			t.Fatalf("quota column missing from %s: %v", table, err)
		}
	}

	if _, err := db.Exec("INSERT INTO media_quota_guards (id, site_id) VALUES ('guard-1', 'site-1')"); err != nil {
		t.Fatal(err)
	}
	var serial int64
	if err := db.QueryRow("SELECT serial FROM media_quota_guards WHERE site_id = 'site-1'").Scan(&serial); err != nil {
		t.Fatal(err)
	}
	if serial != 0 {
		t.Fatalf("new quota guard serial = %d, want 0", serial)
	}
	if _, err := db.Exec("INSERT INTO media_quota_guards (id, site_id) VALUES ('guard-2', 'site-1')"); err == nil {
		t.Fatal("quota guard allowed duplicate site_id")
	}

	if err := executeMigration(db, "20261104000000_media_quotas.down.sql"); err != nil {
		t.Fatal(err)
	}
	var guardCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'media_quota_guards'").Scan(&guardCount); err != nil {
		t.Fatal(err)
	}
	if guardCount != 0 {
		t.Fatal("rollback left media_quota_guards behind")
	}
	if _, err := db.Exec("SELECT media_quota_bytes FROM sites LIMIT 0"); err == nil {
		t.Fatal("rollback left site media_quota_bytes behind")
	}
	if _, err := db.Exec("SELECT media_quota_bytes FROM site_members LIMIT 0"); err == nil {
		t.Fatal("rollback left member media_quota_bytes behind")
	}
}

func executeMigration(db *sql.DB, name string) error {
	script, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	for _, statement := range strings.Split(string(script), ";") {
		statement = strings.TrimSpace(statement)
		if statement == "" {
			continue
		}
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}
