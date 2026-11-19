-- Scheduled publication and per item access control (plan P1-07/P1-08).
--
-- See the sqlite change set for the rationale. The columns are identical apart from
-- the dialect specific timestamp type. Every one defaults so existing rows keep
-- public access, inherited comments and no schedule.

ALTER TABLE content_items ADD COLUMN publish_at DATETIME(6) NULL;
ALTER TABLE content_items ADD COLUMN publish_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE content_items ADD COLUMN access_mode VARCHAR(16) NOT NULL DEFAULT 'public';
ALTER TABLE content_items ADD COLUMN access_password_hash VARCHAR(255) NULL;
ALTER TABLE content_items ADD COLUMN comment_policy VARCHAR(16) NOT NULL DEFAULT 'inherit';

CREATE INDEX contentitem_publish_at ON content_items (publish_at);
