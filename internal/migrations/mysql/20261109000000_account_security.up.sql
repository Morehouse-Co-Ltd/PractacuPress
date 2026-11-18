ALTER TABLE users ADD COLUMN email_verified_at DATETIME(6) NULL;

UPDATE users u
JOIN user_identities ui
  ON ui.user_id = u.id
 AND ui.provider = 'email'
 AND ui.verified_at IS NOT NULL
SET u.email_verified_at = ui.verified_at
WHERE u.email_verified_at IS NULL;

CREATE INDEX auditlog_action_created_at ON audit_logs (action, created_at);
