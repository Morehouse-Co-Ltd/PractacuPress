-- Rollback for the redirect, subscriber, email log, email template and phone code
-- change set and the page view attribution columns. See the .up.sql file for what
-- each object is for.
--
-- Every index is dropped before the table or column it references. On page_views the
-- source and device indexes reference the columns that are removed next and SQLite
-- refuses to drop an indexed column, which is why the index statements come first.
--
-- Cost and risk: the five tables are discarded together with every redirect rule,
-- subscription, mail log row, template override and phone code, and the page view
-- attribution columns are discarded from every row. The page view rows themselves
-- survive with their original columns so the existing traffic counts stay readable.
-- Restore from backup is the fallback when the dropped values must be kept, which is
-- why the forward change set is additive only.
--
-- Applied exactly once, like the up script: SQLite has no DROP COLUMN IF EXISTS. The
-- IF EXISTS guards on the indexes and tables only make a repeated run of the table
-- half harmless.

DROP INDEX IF EXISTS pageview_site_id_source_created_at;
DROP INDEX IF EXISTS pageview_site_id_device_created_at;

DROP INDEX IF EXISTS redirect_site_id_from_path;
DROP INDEX IF EXISTS redirect_site_id_created_at;

DROP INDEX IF EXISTS subscriber_site_id_email;
DROP INDEX IF EXISTS subscriber_token_hash;
DROP INDEX IF EXISTS subscriber_site_id_status_created_at;

DROP INDEX IF EXISTS emaillog_site_id_created_at;
DROP INDEX IF EXISTS emaillog_site_id_status_created_at;

DROP INDEX IF EXISTS emailtemplate_site_id_key;

DROP INDEX IF EXISTS phonecode_site_id_phone_hash_purpose_created_at;
DROP INDEX IF EXISTS phonecode_expires_at;
DROP INDEX IF EXISTS phonecode_site_id_request_ip_hash_created_at;

ALTER TABLE page_views DROP COLUMN device;
ALTER TABLE page_views DROP COLUMN source;
ALTER TABLE page_views DROP COLUMN referrer_host;

DROP TABLE IF EXISTS phone_codes;
DROP TABLE IF EXISTS email_templates;
DROP TABLE IF EXISTS email_logs;
DROP TABLE IF EXISTS subscribers;
DROP TABLE IF EXISTS redirects;
