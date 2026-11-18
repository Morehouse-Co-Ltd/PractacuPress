DROP INDEX auditlog_action_created_at ON audit_logs;

ALTER TABLE users DROP COLUMN email_verified_at;
