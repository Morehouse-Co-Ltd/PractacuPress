DROP TABLE notification_preferences;
DROP INDEX notification_site_id_user_id_dedupe_key_created_at ON notifications;
ALTER TABLE notifications DROP COLUMN dedupe_key;
