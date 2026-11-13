ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ NULL;

UPDATE users u
SET email_verified_at = ui.verified_at
FROM user_identities ui
WHERE ui.user_id = u.id
  AND ui.provider = 'email'
  AND ui.verified_at IS NOT NULL
  AND u.email_verified_at IS NULL;

CREATE INDEX auditlog_action_created_at ON audit_logs (action, created_at);
