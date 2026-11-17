-- Rollback for the redirect, subscriber, email log, email template and phone code
-- change set and the page view attribution columns. See the .up.sql file for what
-- each object is for.
--
-- The indexes are dropped before the columns and tables they reference. On page_views
-- the source and device indexes reference the columns that are removed next. On the
-- five new tables the explicit index drops mirror the other two dialects and keep the
-- rollback order identical everywhere, even though MySQL would remove a table's
-- indexes together with the table.
--
-- MySQL has no IF EXISTS for DROP INDEX or DROP COLUMN, so this rollback expects the
-- forward change set to be fully applied and is itself applied exactly once.
--
-- Cost and risk: the five tables are discarded together with every redirect rule,
-- subscription, mail log row, template override and phone code, and the page view
-- attribution columns are discarded from every row. The page view rows themselves
-- survive with their original columns so the existing traffic counts stay readable.
-- Dropping columns rewrites page_views on MySQL before 8.0.29 and holds a metadata
-- lock for the duration, so run it in a maintenance window on a large ledger. Restore
-- from backup is the fallback when the dropped values must be kept, which is why the
-- forward change set is additive only.

ALTER TABLE page_views DROP INDEX pageview_site_id_source_created_at;
ALTER TABLE page_views DROP INDEX pageview_site_id_device_created_at;

ALTER TABLE redirects DROP INDEX redirect_site_id_from_path;
ALTER TABLE redirects DROP INDEX redirect_site_id_created_at;

ALTER TABLE subscribers DROP INDEX subscriber_site_id_email;
ALTER TABLE subscribers DROP INDEX subscriber_token_hash;
ALTER TABLE subscribers DROP INDEX subscriber_site_id_status_created_at;

ALTER TABLE email_logs DROP INDEX emaillog_site_id_created_at;
ALTER TABLE email_logs DROP INDEX emaillog_site_id_status_created_at;

ALTER TABLE email_templates DROP INDEX emailtemplate_site_id_key;

ALTER TABLE phone_codes DROP INDEX phonecode_site_id_phone_hash_purpose_created_at;
ALTER TABLE phone_codes DROP INDEX phonecode_expires_at;
ALTER TABLE phone_codes DROP INDEX phonecode_site_id_request_ip_hash_created_at;

ALTER TABLE page_views DROP COLUMN device;
ALTER TABLE page_views DROP COLUMN `source`;
ALTER TABLE page_views DROP COLUMN referrer_host;

DROP TABLE IF EXISTS phone_codes;
DROP TABLE IF EXISTS email_templates;
DROP TABLE IF EXISTS email_logs;
DROP TABLE IF EXISTS subscribers;
DROP TABLE IF EXISTS redirects;
