DROP INDEX IF EXISTS auditlog_action_created_at;

ALTER TABLE users DROP COLUMN email_verified_at;
