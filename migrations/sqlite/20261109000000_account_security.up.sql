ALTER TABLE users ADD COLUMN email_verified_at DATETIME NULL;

-- Backfill the account level mirror from the authoritative email identity. Rows
-- created before this change have no account level value, so the first verified
-- identity (there is at most one email identity per account) wins.
UPDATE users
SET email_verified_at = (
    SELECT ui.verified_at
    FROM user_identities ui
    WHERE ui.user_id = users.id
      AND ui.provider = 'email'
      AND ui.verified_at IS NOT NULL
    ORDER BY ui.verified_at DESC
    LIMIT 1
)
WHERE email_verified_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM user_identities ui
    WHERE ui.user_id = users.id
      AND ui.provider = 'email'
      AND ui.verified_at IS NOT NULL
);

-- The admin activity page filters audit rows by action inside a site and a time
-- range; the existing indexes cover site+time and actor+time but not action.
CREATE INDEX auditlog_action_created_at ON audit_logs (action, created_at);
