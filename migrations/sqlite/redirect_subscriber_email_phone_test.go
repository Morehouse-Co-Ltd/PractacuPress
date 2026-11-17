package sqlite_migrations

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// TestRedirectSubscriberEmailPhoneMigration proves the 2026-11-21 change set:
//   - creates the five tables with the column types, nullability and database
//     defaults the Ent schema declares,
//   - creates every index name that the Ent migration would create, so the reviewed
//     SQL path and the Ent schema sync path converge,
//   - adds the three page_views attribution columns and their two indexes,
//   - lets a row be written without the defaulted columns and read back on the values
//     the Ent model would have written, with the unique keys actually enforced, and
//   - rolls back to the pre-change schema without touching the page view rows.
func TestRedirectSubscriberEmailPhoneMigration(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// One connection: an in-memory SQLite database is per connection, so a second
	// pooled connection would silently see an empty schema.
	db.SetMaxOpenConns(1)

	for _, statement := range []string{
		// The page view ledger predates the reviewed change sets. This change set only
		// adds columns and indexes, so the baseline shape is the primary key plus the
		// site_id / created_at pair the new indexes are scoped by.
		"CREATE TABLE page_views (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, created_at DATETIME NOT NULL)",
		// A page view written before the change set: the three new columns have to
		// default, and the row itself has to survive the rollback.
		"INSERT INTO page_views (id, site_id, created_at) VALUES ('pv_legacy', 'site_1', '2026-11-01T00:00:00Z')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	if err := executeMigration(db, "20261121000000_redirect_subscriber_email_phone.up.sql"); err != nil {
		t.Fatal(err)
	}

	// All five tables exist.
	for _, table := range []string{
		"redirects", "subscribers", "email_logs", "email_templates", "phone_codes",
	} {
		if !sqliteTableExists(t, db, table) {
			t.Fatalf("change set left table %s out", table)
		}
	}

	// Every column exists with the declared type, nullability and default. The
	// defaults mirror the Ent schema, which is what keeps a row written around the ORM
	// (import, fixture, manual repair) on the same values the ORM would have chosen.
	expectations := []columnExpectation{
		// redirects: one normalised URL rule per site.
		{"redirects", "id", "VARCHAR(36)", true, false, ""},
		{"redirects", "site_id", "VARCHAR(36)", true, false, ""},
		{"redirects", "from_path", "VARCHAR(512)", true, false, ""},
		{"redirects", "to_path", "VARCHAR(512)", true, false, ""},
		{"redirects", "status_code", "INTEGER", true, true, "301"},
		{"redirects", "source", "VARCHAR(20)", true, true, "manual"},
		{"redirects", "hit_count", "INTEGER", true, true, "0"},
		{"redirects", "created_at", "DATETIME", true, false, ""},
		{"redirects", "updated_at", "DATETIME", true, false, ""},
		// subscribers: one lowercase address per site, token hash only.
		{"subscribers", "id", "VARCHAR(36)", true, false, ""},
		{"subscribers", "site_id", "VARCHAR(36)", true, false, ""},
		{"subscribers", "email", "VARCHAR(320)", true, false, ""},
		{"subscribers", "status", "VARCHAR(20)", true, true, "pending"},
		{"subscribers", "token_hash", "VARCHAR(64)", true, false, ""},
		{"subscribers", "source", "VARCHAR(40)", true, true, "site"},
		{"subscribers", "user_id", "VARCHAR(36)", false, false, ""},
		{"subscribers", "confirmed_at", "DATETIME", false, false, ""},
		{"subscribers", "unsubscribed_at", "DATETIME", false, false, ""},
		{"subscribers", "last_sent_at", "DATETIME", false, false, ""},
		{"subscribers", "created_at", "DATETIME", true, false, ""},
		{"subscribers", "updated_at", "DATETIME", true, false, ""},
		// email_logs: one row per outbound message.
		{"email_logs", "id", "VARCHAR(36)", true, false, ""},
		{"email_logs", "site_id", "VARCHAR(36)", true, false, ""},
		{"email_logs", "to_email", "VARCHAR(320)", true, false, ""},
		{"email_logs", "kind", "VARCHAR(20)", true, true, "system"},
		{"email_logs", "template_key", "VARCHAR(80)", true, true, ""},
		{"email_logs", "subject", "VARCHAR(300)", true, true, ""},
		{"email_logs", "status", "VARCHAR(20)", true, true, "queued"},
		{"email_logs", "error", "VARCHAR(500)", false, false, ""},
		{"email_logs", "provider_message_id", "VARCHAR(200)", false, false, ""},
		{"email_logs", "subscriber_id", "VARCHAR(36)", false, false, ""},
		{"email_logs", "sent_at", "DATETIME", false, false, ""},
		{"email_logs", "created_at", "DATETIME", true, false, ""},
		// email_templates: one editable override per site and key.
		{"email_templates", "id", "VARCHAR(36)", true, false, ""},
		{"email_templates", "site_id", "VARCHAR(36)", true, false, ""},
		{"email_templates", "key", "VARCHAR(80)", true, false, ""},
		{"email_templates", "name", "VARCHAR(120)", true, true, ""},
		{"email_templates", "subject", "VARCHAR(300)", true, true, ""},
		{"email_templates", "body_html", "TEXT", true, true, ""},
		{"email_templates", "body_text", "TEXT", true, true, ""},
		{"email_templates", "enabled", "INTEGER", true, true, "1"},
		{"email_templates", "created_at", "DATETIME", true, false, ""},
		{"email_templates", "updated_at", "DATETIME", true, false, ""},
		// phone_codes: one short lived SMS code.
		{"phone_codes", "id", "VARCHAR(36)", true, false, ""},
		{"phone_codes", "site_id", "VARCHAR(36)", true, false, ""},
		{"phone_codes", "phone_hash", "VARCHAR(64)", true, false, ""},
		{"phone_codes", "phone_masked", "VARCHAR(32)", true, true, ""},
		{"phone_codes", "purpose", "VARCHAR(20)", true, true, "login"},
		{"phone_codes", "code_hash", "VARCHAR(64)", true, false, ""},
		{"phone_codes", "attempts", "INTEGER", true, true, "0"},
		{"phone_codes", "request_ip_hash", "VARCHAR(64)", true, true, ""},
		{"phone_codes", "expires_at", "DATETIME", true, false, ""},
		{"phone_codes", "consumed_at", "DATETIME", false, false, ""},
		{"phone_codes", "created_at", "DATETIME", true, false, ""},
		// page_views: the traffic attribution columns added to the existing ledger.
		{"page_views", "referrer_host", "VARCHAR(255)", true, true, ""},
		{"page_views", "source", "VARCHAR(20)", true, true, "unknown"},
		{"page_views", "device", "VARCHAR(20)", true, true, "unknown"},
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

	// Every index carries the name the Ent schema declares, on the same columns. The
	// index names are what makes the reviewed SQL converge with the Ent schema sync:
	// two objects with the same name and shape are the same index.
	indexes := []struct {
		name    string
		table   string
		columns []string
	}{
		{"redirect_site_id_from_path", "redirects", []string{"site_id", "from_path"}},
		{"redirect_site_id_created_at", "redirects", []string{"site_id", "created_at"}},
		{"subscriber_site_id_email", "subscribers", []string{"site_id", "email"}},
		{"subscriber_token_hash", "subscribers", []string{"token_hash"}},
		{"subscriber_site_id_status_created_at", "subscribers", []string{"site_id", "status", "created_at"}},
		{"emaillog_site_id_created_at", "email_logs", []string{"site_id", "created_at"}},
		{"emaillog_site_id_status_created_at", "email_logs", []string{"site_id", "status", "created_at"}},
		{"emailtemplate_site_id_key", "email_templates", []string{"site_id", "key"}},
		{"phonecode_site_id_phone_hash_purpose_created_at", "phone_codes", []string{"site_id", "phone_hash", "purpose", "created_at"}},
		{"phonecode_expires_at", "phone_codes", []string{"expires_at"}},
		{"phonecode_site_id_request_ip_hash_created_at", "phone_codes", []string{"site_id", "request_ip_hash", "created_at"}},
		{"pageview_site_id_source_created_at", "page_views", []string{"site_id", "source", "created_at"}},
		{"pageview_site_id_device_created_at", "page_views", []string{"site_id", "device", "created_at"}},
	}
	for _, want := range indexes {
		got := indexColumns(t, db, want.name, want.table)
		if len(got) != len(want.columns) {
			t.Fatalf("index %s columns = %v, want %v", want.name, got, want.columns)
		}
		for i := range want.columns {
			if got[i] != want.columns[i] {
				t.Fatalf("index %s columns = %v, want %v", want.name, got, want.columns)
			}
		}
	}

	// Rows are written without the defaulted columns, exactly like a fixture or an
	// import would, and read back on the values the Ent model promises.

	if _, err := db.Exec(`INSERT INTO redirects
		(id, site_id, from_path, to_path, created_at, updated_at)
		VALUES ('red_1', 'site_1', '/a/old-title', '/a/new-title',
			'2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	var (
		statusCode int
		source     string
		hitCount   int
	)
	if err := db.QueryRow(`SELECT status_code, source, hit_count FROM redirects
		WHERE id = 'red_1'`).Scan(&statusCode, &source, &hitCount); err != nil {
		t.Fatal(err)
	}
	if statusCode != 301 || source != "manual" || hitCount != 0 {
		t.Fatalf("redirect defaults = (%d, %q, %d), want (301, manual, 0)",
			statusCode, source, hitCount)
	}

	if _, err := db.Exec(`INSERT INTO subscribers
		(id, site_id, email, token_hash, created_at, updated_at)
		VALUES ('sub_1', 'site_1', 'alice@example.com', 'hash-1',
			'2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	var (
		subscriberStatus string
		subscriberSource string
		subscriberUser   sql.NullString
		confirmedAt      sql.NullString
	)
	if err := db.QueryRow(`SELECT status, source, user_id, confirmed_at FROM subscribers
		WHERE id = 'sub_1'`).Scan(&subscriberStatus, &subscriberSource, &subscriberUser, &confirmedAt); err != nil {
		t.Fatal(err)
	}
	if subscriberStatus != "pending" || subscriberSource != "site" ||
		subscriberUser.Valid || confirmedAt.Valid {
		t.Fatalf("subscriber defaults = (%q, %q, %v, %v), want (pending, site, NULL, NULL)",
			subscriberStatus, subscriberSource, subscriberUser, confirmedAt)
	}

	if _, err := db.Exec(`INSERT INTO email_logs (id, site_id, to_email, created_at)
		VALUES ('mail_1', 'site_1', 'alice@example.com', '2026-11-21T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	var (
		emailKind       string
		templateKey     string
		emailSubject    string
		emailStatus     string
		emailError      sql.NullString
		providerMessage sql.NullString
		emailSubscriber sql.NullString
		emailSentAt     sql.NullString
	)
	if err := db.QueryRow(`SELECT kind, template_key, subject, status, error,
		provider_message_id, subscriber_id, sent_at FROM email_logs WHERE id = 'mail_1'`).
		Scan(&emailKind, &templateKey, &emailSubject, &emailStatus, &emailError,
			&providerMessage, &emailSubscriber, &emailSentAt); err != nil {
		t.Fatal(err)
	}
	if emailKind != "system" || templateKey != "" || emailSubject != "" || emailStatus != "queued" ||
		emailError.Valid || providerMessage.Valid || emailSubscriber.Valid || emailSentAt.Valid {
		t.Fatalf("email log defaults = (%q, %q, %q, %q), nullable = (%v, %v, %v, %v), want (system, '', '', queued) and all NULL",
			emailKind, templateKey, emailSubject, emailStatus,
			emailError.Valid, providerMessage.Valid, emailSubscriber.Valid, emailSentAt.Valid)
	}

	if _, err := db.Exec(`INSERT INTO email_templates (id, site_id, key, created_at, updated_at)
		VALUES ('tpl_1', 'site_1', 'subscriber_confirm',
			'2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	var (
		templateName    string
		templateSubject string
		bodyHTML        string
		bodyText        string
		enabled         int
	)
	if err := db.QueryRow(`SELECT name, subject, body_html, body_text, enabled
		FROM email_templates WHERE id = 'tpl_1'`).
		Scan(&templateName, &templateSubject, &bodyHTML, &bodyText, &enabled); err != nil {
		t.Fatal(err)
	}
	if templateName != "" || templateSubject != "" || bodyHTML != "" || bodyText != "" || enabled != 1 {
		t.Fatalf("email template defaults = (%q, %q, %q, %q, %d), want ('', '', '', '', 1)",
			templateName, templateSubject, bodyHTML, bodyText, enabled)
	}

	if _, err := db.Exec(`INSERT INTO phone_codes
		(id, site_id, phone_hash, code_hash, expires_at, created_at)
		VALUES ('code_1', 'site_1', 'phone-hash-1', 'code-hash-1',
			'2026-11-21T00:05:00Z', '2026-11-21T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	var (
		phoneMasked   string
		purpose       string
		attempts      int
		requestIPHash string
		phoneConsumed sql.NullString
	)
	if err := db.QueryRow(`SELECT phone_masked, purpose, attempts, request_ip_hash, consumed_at
		FROM phone_codes WHERE id = 'code_1'`).
		Scan(&phoneMasked, &purpose, &attempts, &requestIPHash, &phoneConsumed); err != nil {
		t.Fatal(err)
	}
	if phoneMasked != "" || purpose != "login" || attempts != 0 || requestIPHash != "" ||
		phoneConsumed.Valid {
		t.Fatalf("phone code defaults = (%q, %q, %d, %q, %v), want ('', login, 0, '', NULL)",
			phoneMasked, purpose, attempts, requestIPHash, phoneConsumed)
	}

	// The unique keys are enforced, not just declared: a second rule for the same
	// incoming path inside a site, a second subscription for the same address, a
	// reused token hash and a second template override for the same key all fail.
	if _, err := db.Exec(`INSERT INTO redirects
		(id, site_id, from_path, to_path, created_at, updated_at)
		VALUES ('red_2', 'site_1', '/a/old-title', '/a/other-title',
			'2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z')`); err == nil {
		t.Fatal("redirects allowed a duplicate (site_id, from_path)")
	}
	if _, err := db.Exec(`INSERT INTO subscribers
		(id, site_id, email, token_hash, created_at, updated_at)
		VALUES ('sub_2', 'site_1', 'alice@example.com', 'hash-2',
			'2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z')`); err == nil {
		t.Fatal("subscribers allowed a duplicate (site_id, email)")
	}
	if _, err := db.Exec(`INSERT INTO subscribers
		(id, site_id, email, token_hash, created_at, updated_at)
		VALUES ('sub_3', 'site_2', 'bob@example.com', 'hash-1',
			'2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z')`); err == nil {
		t.Fatal("subscribers allowed a reused token_hash")
	}
	if _, err := db.Exec(`INSERT INTO email_templates (id, site_id, key, created_at, updated_at)
		VALUES ('tpl_2', 'site_1', 'subscriber_confirm',
			'2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z')`); err == nil {
		t.Fatal("email_templates allowed a duplicate (site_id, key)")
	}

	// The legacy page view adopts the documented defaults: empty referrer host and
	// the "unknown" source and device classes, because the row predates attribution.
	var (
		legacyHost   string
		legacySource string
		legacyDevice string
	)
	if err := db.QueryRow(`SELECT referrer_host, source, device FROM page_views
		WHERE id = 'pv_legacy'`).Scan(&legacyHost, &legacySource, &legacyDevice); err != nil {
		t.Fatal(err)
	}
	if legacyHost != "" || legacySource != "unknown" || legacyDevice != "unknown" {
		t.Fatalf("legacy page view defaults = (%q, %q, %q), want ('', unknown, unknown)",
			legacyHost, legacySource, legacyDevice)
	}

	// A new page view stores the derived values, and the column pair is indexed by
	// the two new indexes asserted above.
	if _, err := db.Exec(`INSERT INTO page_views
		(id, site_id, created_at, referrer_host, source, device)
		VALUES ('pv_new', 'site_1', '2026-11-21T00:00:00Z',
			'news.ycombinator.com', 'referral', 'mobile')`); err != nil {
		t.Fatal(err)
	}
	var (
		newHost   string
		newSource string
		newDevice string
	)
	if err := db.QueryRow(`SELECT referrer_host, source, device FROM page_views
		WHERE id = 'pv_new'`).Scan(&newHost, &newSource, &newDevice); err != nil {
		t.Fatal(err)
	}
	if newHost != "news.ycombinator.com" || newSource != "referral" || newDevice != "mobile" {
		t.Fatalf("new page view attribution = (%q, %q, %q), want (news.ycombinator.com, referral, mobile)",
			newHost, newSource, newDevice)
	}

	// Rollback: every index goes before the table or column it references, then the
	// columns of page_views and the five tables.
	if err := executeMigration(db, "20261121000000_redirect_subscriber_email_phone.down.sql"); err != nil {
		t.Fatalf("rollback failed: %v", err)
	}
	for _, table := range []string{
		"redirects", "subscribers", "email_logs", "email_templates", "phone_codes",
	} {
		if sqliteTableExists(t, db, table) {
			t.Fatalf("rollback left table %s behind", table)
		}
	}
	for _, column := range []string{"referrer_host", "source", "device"} {
		if _, err := db.Exec("SELECT " + column + " FROM page_views LIMIT 0"); err == nil {
			t.Fatalf("rollback left page_views.%s behind", column)
		}
	}
	for _, want := range indexes {
		if sqliteIndexExists(t, db, want.name) {
			t.Fatalf("rollback left index %s behind", want.name)
		}
	}

	// The additive change set only ever added columns, so both page view rows survive
	// the rollback with their original columns.
	var rows int
	if err := db.QueryRow("SELECT COUNT(*) FROM page_views").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("page_views kept %d rows after rollback, want 2", rows)
	}
	var siteID string
	if err := db.QueryRow("SELECT site_id FROM page_views WHERE id = 'pv_legacy'").Scan(&siteID); err != nil {
		t.Fatalf("rollback damaged the page view row: %v", err)
	}
	if siteID != "site_1" {
		t.Fatalf("page_views.site_id = %q after rollback, want site_1", siteID)
	}
}

// sqliteTableExists reports whether the connected SQLite database still has a table
// with this name.
func sqliteTableExists(t *testing.T, db *sql.DB, table string) bool {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name = ?`, table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}

// sqliteIndexExists reports whether the connected SQLite database still has an index
// with this name. SQLite exposes a table's implicit primary key index as a separate
// sqlite_master row, so this only answers for the named indexes.
func sqliteIndexExists(t *testing.T, db *sql.DB, index string) bool {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'index' AND name = ?`, index).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}
