ALTER TABLE content_items DROP INDEX contentitem_publish_at;
ALTER TABLE content_items DROP COLUMN comment_policy;
ALTER TABLE content_items DROP COLUMN access_password_hash;
ALTER TABLE content_items DROP COLUMN access_mode;
ALTER TABLE content_items DROP COLUMN publish_attempts;
ALTER TABLE content_items DROP COLUMN publish_at;
