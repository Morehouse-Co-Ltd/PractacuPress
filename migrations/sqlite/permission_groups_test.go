package sqlite_migrations

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestPermissionGroupMigrationAddsGroupsAndMemberKey(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.Exec("CREATE TABLE site_members (id TEXT PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}

	if err := executeMigration(db, "20261119000000_permission_groups.up.sql"); err != nil {
		t.Fatal(err)
	}

	// Existing memberships keep deriving their group from the role.
	if _, err := db.Exec("INSERT INTO site_members (id) VALUES ('member-1')"); err != nil {
		t.Fatal(err)
	}
	var groupKey string
	if err := db.QueryRow("SELECT group_key FROM site_members WHERE id = 'member-1'").Scan(&groupKey); err != nil {
		t.Fatal(err)
	}
	if groupKey != "" {
		t.Fatalf("existing membership group_key = %q, want empty", groupKey)
	}

	// A group row stores the label, base role and capability list.
	if _, err := db.Exec(`INSERT INTO permission_groups
		(id, site_id, key, name, base_role, capabilities, admin_access, builtin, created_at, updated_at)
		VALUES ('pg-1', 'site-1', 'ops', '运营组', 'site_admin', '["read_content","manage_site"]', 1, 0,
			'2026-11-19T00:00:00Z', '2026-11-19T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	var name, capabilities string
	if err := db.QueryRow("SELECT name, capabilities FROM permission_groups WHERE key = 'ops'").Scan(&name, &capabilities); err != nil {
		t.Fatal(err)
	}
	if name != "运营组" || capabilities != `["read_content","manage_site"]` {
		t.Fatalf("stored group = %q / %q", name, capabilities)
	}

	// One row per site and key.
	if _, err := db.Exec(`INSERT INTO permission_groups
		(id, site_id, key, name, base_role, capabilities, admin_access, builtin, created_at, updated_at)
		VALUES ('pg-2', 'site-1', 'ops', 'Duplicate', 'member', '[]', 0, 0,
			'2026-11-19T00:00:00Z', '2026-11-19T00:00:00Z')`); err == nil {
		t.Fatal("permission_groups allowed a duplicate (site_id, key)")
	}

	if err := executeMigration(db, "20261119000000_permission_groups.down.sql"); err != nil {
		t.Fatal(err)
	}
	var tableCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name = 'permission_groups'`).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if tableCount != 0 {
		t.Fatal("rollback left the permission_groups table behind")
	}
	if _, err := db.Exec("SELECT group_key FROM site_members LIMIT 0"); err == nil {
		t.Fatal("rollback left site_members.group_key behind")
	}
}
