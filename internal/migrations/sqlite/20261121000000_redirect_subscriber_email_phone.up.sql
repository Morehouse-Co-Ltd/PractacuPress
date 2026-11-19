-- Redirects, newsletter subscribers, the outbound mail log, editable mail templates
-- and short lived SMS login codes, plus the traffic attribution columns of the page
-- view ledger.
--
-- Five new tables, all scoped to a site and all read by the admin dashboard or the
-- public write path:
--   * redirects          permanent and temporary URL rules. from_path is stored
--                        normalised (leading slash, no query, no trailing slash except
--                        the root) and is unique per site, so resolution is an exact
--                        match and the order of two rules can never decide the result.
--   * subscribers        one newsletter entry per site and address. email is stored
--                        lowercase, so the unique (site_id, email) key makes
--                        "Alice@Example.com" and "alice@example.com" the same
--                        subscription. Only token_hash is stored, never the plaintext
--                        confirmation or unsubscribe token, so a database leak cannot
--                        be replayed as a link.
--   * email_logs         one row per outbound message, written before the message is
--                        handed to the relay and updated with the outcome. The body is
--                        never stored, only the subject and the template key.
--   * email_templates    one editable override per site and key. A missing row means
--                        "use the shipped default", so no site needs a backfill.
--   * phone_codes        one short lived SMS code. The number is only stored as a
--                        keyed hash plus a masked display value.
--
-- page_views gains the three traffic attribution columns:
--   * referrer_host      host of the incoming referrer, lowercased, without scheme or
--                        path. Empty for a direct visit.
--   * source             direct / search / social / referral / internal / unknown,
--                        derived on the server from the referrer host.
--   * device             desktop / mobile / tablet / bot / unknown, derived from the
--                        User-Agent at write time (the header itself is never stored).
-- plus the two reporting indexes pageview_site_id_source_created_at and
-- pageview_site_id_device_created_at that answer the per window breakdowns. The other
-- two page_views indexes (surface and session) predate this change set and are left
-- alone.
--
-- Every new column that is not a primary key, a required site/owner column or an
-- instant has a database default, and the default mirrors the Ent schema exactly:
-- status_code 301, redirect source 'manual', subscriber status 'pending', email kind
-- 'system', email status 'queued', template enabled 1, phone code purpose 'login' and
-- page view source/device 'unknown'. A row written by a path that does not know the
-- field therefore lands on the value the Ent model would have written.
--
-- Types follow the rest of this dialect: booleans are INTEGER 0/1, instants are
-- DATETIME, identifiers are VARCHAR(36) UUIDv7 text, free form documents are TEXT and
-- the closed value set columns are bounded VARCHAR so a typo is rejected by the
-- length as well as by the Ent validator.
--
-- Re-running: SQLite has no ADD COLUMN IF NOT EXISTS and the versioned script
-- convention here is a single reviewed change set applied exactly once, which is what
-- the separate migration step guarantees (see migrations/README.md). A half applied
-- run is repaired by listing the objects that are already there and issuing only the
-- missing statements:
--   sqlite3 data/practacu.db ".tables"
--   sqlite3 data/practacu.db "PRAGMA table_info(page_views)"
-- The down script drops every index before the table or column it references because
-- SQLite refuses to drop an indexed column.
--
-- Apply this change set before deploying the API that reads these tables.

CREATE TABLE redirects (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    from_path VARCHAR(512) NOT NULL,
    to_path VARCHAR(512) NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 301,
    source VARCHAR(20) NOT NULL DEFAULT 'manual',
    hit_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX redirect_site_id_from_path ON redirects (site_id, from_path);
CREATE INDEX redirect_site_id_created_at ON redirects (site_id, created_at);

CREATE TABLE subscribers (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    email VARCHAR(320) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    token_hash VARCHAR(64) NOT NULL,
    source VARCHAR(40) NOT NULL DEFAULT 'site',
    user_id VARCHAR(36) NULL,
    confirmed_at DATETIME NULL,
    unsubscribed_at DATETIME NULL,
    last_sent_at DATETIME NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX subscriber_site_id_email ON subscribers (site_id, email);
CREATE UNIQUE INDEX subscriber_token_hash ON subscribers (token_hash);
CREATE INDEX subscriber_site_id_status_created_at ON subscribers (site_id, status, created_at);

CREATE TABLE email_logs (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    to_email VARCHAR(320) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'system',
    template_key VARCHAR(80) NOT NULL DEFAULT '',
    subject VARCHAR(300) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    error VARCHAR(500) NULL,
    provider_message_id VARCHAR(200) NULL,
    subscriber_id VARCHAR(36) NULL,
    sent_at DATETIME NULL,
    created_at DATETIME NOT NULL
);

CREATE INDEX emaillog_site_id_created_at ON email_logs (site_id, created_at);
CREATE INDEX emaillog_site_id_status_created_at ON email_logs (site_id, status, created_at);

CREATE TABLE email_templates (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    key VARCHAR(80) NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT '',
    subject VARCHAR(300) NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX emailtemplate_site_id_key ON email_templates (site_id, key);

CREATE TABLE phone_codes (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    phone_hash VARCHAR(64) NOT NULL,
    phone_masked VARCHAR(32) NOT NULL DEFAULT '',
    purpose VARCHAR(20) NOT NULL DEFAULT 'login',
    code_hash VARCHAR(64) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    request_ip_hash VARCHAR(64) NOT NULL DEFAULT '',
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME NULL,
    created_at DATETIME NOT NULL
);

CREATE INDEX phonecode_site_id_phone_hash_purpose_created_at
    ON phone_codes (site_id, phone_hash, purpose, created_at);
CREATE INDEX phonecode_expires_at ON phone_codes (expires_at);
CREATE INDEX phonecode_site_id_request_ip_hash_created_at
    ON phone_codes (site_id, request_ip_hash, created_at);

ALTER TABLE page_views ADD COLUMN referrer_host VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE page_views ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'unknown';
ALTER TABLE page_views ADD COLUMN device VARCHAR(20) NOT NULL DEFAULT 'unknown';

CREATE INDEX pageview_site_id_source_created_at
    ON page_views (site_id, source, created_at);
CREATE INDEX pageview_site_id_device_created_at
    ON page_views (site_id, device, created_at);
