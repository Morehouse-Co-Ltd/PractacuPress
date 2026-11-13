-- Scheduled publication and per item access control (plan P1-07/P1-08, FSD C-17/C-18/C-19).
--
-- publish_at is the pending publication instant the background publisher claims for
-- a draft. publish_attempts bounds the retries after a failed pass so an item that
-- cannot be sanitized is not retried forever.
--
-- access_mode is one of public, password or members. access_password_hash stores the
-- Argon2id hash only. A public item always has NULL here. comment_policy overrides
-- the site level comment switches per item (inherit, open, disabled, review).
--
-- Every column has a default, so existing rows keep their current behaviour: public
-- access, inherited comments and no schedule.

ALTER TABLE content_items ADD COLUMN publish_at DATETIME NULL;
ALTER TABLE content_items ADD COLUMN publish_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_items ADD COLUMN access_mode VARCHAR(16) NOT NULL DEFAULT 'public';
ALTER TABLE content_items ADD COLUMN access_password_hash VARCHAR(255) NULL;
ALTER TABLE content_items ADD COLUMN comment_policy VARCHAR(16) NOT NULL DEFAULT 'inherit';

CREATE INDEX contentitem_publish_at ON content_items (publish_at);
