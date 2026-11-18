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
-- Types follow the rest of this dialect: a TIMESTAMPTZ instant keeps the stored time
-- UTC on every deployment, booleans are native BOOLEAN, counters are INTEGER,
-- identifiers are VARCHAR(36), free form documents are TEXT and the closed value set
-- columns are bounded VARCHAR(20) so a typo is rejected by the length as well as by
-- the Ent validator.
--
-- Every new column that is not a primary key, a required site/owner column or an
-- instant has a database default, and the default mirrors the Ent schema exactly:
-- status_code 301, redirect source 'manual', subscriber status 'pending', email kind
-- 'system', email status 'queued', template enabled TRUE, phone code purpose 'login'
-- and page view source/device 'unknown'.
--
-- Re-running: this dialect supports CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS and ADD COLUMN IF NOT EXISTS, so the script is genuinely idempotent and can
-- be re-applied after a partial run. A constant DEFAULT means PostgreSQL 11+ adds each
-- page_views column without rewriting the table, so the whole change set is a catalogue
-- update plus the index builds.
--
-- Apply this change set before deploying the API that reads these tables.

CREATE TABLE IF NOT EXISTS redirects (
    id VARCHAR(36) PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    from_path VARCHAR(512) NOT NULL,
    to_path VARCHAR(512) NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 301,
    source VARCHAR(20) NOT NULL DEFAULT 'manual',
    hit_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS redirect_site_id_from_path
    ON redirects (site_id, from_path);
CREATE INDEX IF NOT EXISTS redirect_site_id_created_at
    ON redirects (site_id, created_at);

CREATE TABLE IF NOT EXISTS subscribers (
    id VARCHAR(36) PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    email VARCHAR(320) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    token_hash VARCHAR(64) NOT NULL,
    source VARCHAR(40) NOT NULL DEFAULT 'site',
    user_id VARCHAR(36) NULL,
    confirmed_at TIMESTAMPTZ NULL,
    unsubscribed_at TIMESTAMPTZ NULL,
    last_sent_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriber_site_id_email
    ON subscribers (site_id, email);
CREATE UNIQUE INDEX IF NOT EXISTS subscriber_token_hash
    ON subscribers (token_hash);
CREATE INDEX IF NOT EXISTS subscriber_site_id_status_created_at
    ON subscribers (site_id, status, created_at);

CREATE TABLE IF NOT EXISTS email_logs (
    id VARCHAR(36) PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    to_email VARCHAR(320) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'system',
    template_key VARCHAR(80) NOT NULL DEFAULT '',
    subject VARCHAR(300) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    error VARCHAR(500) NULL,
    provider_message_id VARCHAR(200) NULL,
    subscriber_id VARCHAR(36) NULL,
    sent_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS emaillog_site_id_created_at
    ON email_logs (site_id, created_at);
CREATE INDEX IF NOT EXISTS emaillog_site_id_status_created_at
    ON email_logs (site_id, status, created_at);

CREATE TABLE IF NOT EXISTS email_templates (
    id VARCHAR(36) PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    key VARCHAR(80) NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT '',
    subject VARCHAR(300) NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS emailtemplate_site_id_key
    ON email_templates (site_id, key);

CREATE TABLE IF NOT EXISTS phone_codes (
    id VARCHAR(36) PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    phone_hash VARCHAR(64) NOT NULL,
    phone_masked VARCHAR(32) NOT NULL DEFAULT '',
    purpose VARCHAR(20) NOT NULL DEFAULT 'login',
    code_hash VARCHAR(64) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    request_ip_hash VARCHAR(64) NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS phonecode_site_id_phone_hash_purpose_created_at
    ON phone_codes (site_id, phone_hash, purpose, created_at);
CREATE INDEX IF NOT EXISTS phonecode_expires_at ON phone_codes (expires_at);
CREATE INDEX IF NOT EXISTS phonecode_site_id_request_ip_hash_created_at
    ON phone_codes (site_id, request_ip_hash, created_at);

ALTER TABLE page_views ADD COLUMN IF NOT EXISTS referrer_host VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'unknown';
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS device VARCHAR(20) NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS pageview_site_id_source_created_at
    ON page_views (site_id, source, created_at);
CREATE INDEX IF NOT EXISTS pageview_site_id_device_created_at
    ON page_views (site_id, device, created_at);
