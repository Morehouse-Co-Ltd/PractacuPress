-- Redirects, newsletter subscribers, the outbound mail log, editable mail templates
-- and short lived SMS login codes, plus the traffic attribution columns of the page
-- view ledger.
--
-- See the sqlite change set for the rationale behind each table and column. In short:
-- redirects holds one normalised URL rule per (site_id, from_path), subscribers keeps
-- one lowercase address per site and only stores the token hash, email_logs records
-- every outbound message, email_templates stores one editable override per site and
-- key, phone_codes stores short lived SMS codes as a keyed hash plus a masked display
-- value, and page_views gains referrer_host, source and device plus the two reporting
-- indexes on (site_id, source, created_at) and (site_id, device, created_at).
--
-- Types follow the rest of this dialect: DATETIME(6) for every instant, TINYINT(1) for
-- the boolean (BOOLEAN is only an alias for it and DEFAULT 1 is what the Ent model
-- reads back), INT for the integer counters, LONGTEXT for the field.Text template
-- bodies and VARCHAR(36) for the UUIDv7 identifiers. The closed value set columns are
-- bounded VARCHAR(20) so a typo is rejected by the length as well as by the Ent
-- validator. `key` is a reserved word here and is quoted.
--
-- Every new column that is not a primary key, a required site/owner column or an
-- instant has a database default, and the default mirrors the Ent schema exactly:
-- status_code 301, redirect source 'manual', subscriber status 'pending', email kind
-- 'system', email status 'queued', template enabled 1, phone code purpose 'login' and
-- page view source/device 'unknown'.
--
-- MySQL has no literal DEFAULT for TEXT / BLOB columns, only an expression default
-- (MySQL 8.0.13+). The parenthesised DEFAULT ('') below is that form and means exactly
-- what DEFAULT '' means on the other two dialects. On a server older than 8.0.13 the
-- statement is rejected instead of silently storing NULL, in which case add the two
-- columns without a default, backfill them with UPDATE, and then tighten them with
-- MODIFY NOT NULL.
--
-- Re-running: MySQL has neither ADD COLUMN IF NOT EXISTS nor CREATE TABLE / CREATE
-- INDEX IF NOT EXISTS, so this script is applied exactly once per database. That is
-- what the release step guarantees: the reviewed change set is a separate migration
-- step, not something the API re-applies (see migrations/README.md). A half applied
-- run is repaired by listing the objects that are already there and issuing only the
-- missing statements:
--   SHOW TABLES LIKE 'redirects'
--   SHOW COLUMNS FROM page_views
--
-- Apply this change set before deploying the API that reads these tables.

CREATE TABLE redirects (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    from_path VARCHAR(512) NOT NULL,
    to_path VARCHAR(512) NOT NULL,
    status_code INT NOT NULL DEFAULT 301,
    `source` VARCHAR(20) NOT NULL DEFAULT 'manual',
    hit_count INT NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY redirect_site_id_from_path (site_id, from_path),
    KEY redirect_site_id_created_at (site_id, created_at)
);

CREATE TABLE subscribers (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    email VARCHAR(320) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    token_hash VARCHAR(64) NOT NULL,
    `source` VARCHAR(40) NOT NULL DEFAULT 'site',
    user_id VARCHAR(36) NULL,
    confirmed_at DATETIME(6) NULL,
    unsubscribed_at DATETIME(6) NULL,
    last_sent_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY subscriber_site_id_email (site_id, email),
    UNIQUE KEY subscriber_token_hash (token_hash),
    KEY subscriber_site_id_status_created_at (site_id, status, created_at)
);

CREATE TABLE email_logs (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    to_email VARCHAR(320) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'system',
    template_key VARCHAR(80) NOT NULL DEFAULT '',
    subject VARCHAR(300) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    error VARCHAR(500) NULL,
    provider_message_id VARCHAR(200) NULL,
    subscriber_id VARCHAR(36) NULL,
    sent_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    KEY emaillog_site_id_created_at (site_id, created_at),
    KEY emaillog_site_id_status_created_at (site_id, status, created_at)
);

CREATE TABLE email_templates (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    `key` VARCHAR(80) NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT '',
    subject VARCHAR(300) NOT NULL DEFAULT '',
    body_html LONGTEXT NOT NULL DEFAULT (''),
    body_text LONGTEXT NOT NULL DEFAULT (''),
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY emailtemplate_site_id_key (site_id, `key`)
);

CREATE TABLE phone_codes (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    phone_hash VARCHAR(64) NOT NULL,
    phone_masked VARCHAR(32) NOT NULL DEFAULT '',
    purpose VARCHAR(20) NOT NULL DEFAULT 'login',
    code_hash VARCHAR(64) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    request_ip_hash VARCHAR(64) NOT NULL DEFAULT '',
    expires_at DATETIME(6) NOT NULL,
    consumed_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    KEY phonecode_site_id_phone_hash_purpose_created_at (site_id, phone_hash, purpose, created_at),
    KEY phonecode_expires_at (expires_at),
    KEY phonecode_site_id_request_ip_hash_created_at (site_id, request_ip_hash, created_at)
);

ALTER TABLE page_views ADD COLUMN referrer_host VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE page_views ADD COLUMN `source` VARCHAR(20) NOT NULL DEFAULT 'unknown';
ALTER TABLE page_views ADD COLUMN device VARCHAR(20) NOT NULL DEFAULT 'unknown';

CREATE INDEX pageview_site_id_source_created_at
    ON page_views (site_id, `source`, created_at);
CREATE INDEX pageview_site_id_device_created_at
    ON page_views (site_id, device, created_at);
