-- Notification preferences and interaction dedupe.
--
-- The inbox now receives comment, reply, like and follow rows, and can optionally
-- mirror them as email. The preference table holds one row per member and site; a
-- missing row is the default (in-app on, email off), so nothing has to be backfilled.
-- dedupe_key collapses a like/unlike/like burst into one inbox row.

ALTER TABLE notifications ADD COLUMN dedupe_key VARCHAR(120) NULL;
CREATE INDEX notification_site_id_user_id_dedupe_key_created_at
    ON notifications (site_id, user_id, dedupe_key, created_at);

CREATE TABLE notification_preferences (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    in_app_enabled INTEGER NOT NULL DEFAULT 1,
    email_enabled INTEGER NOT NULL DEFAULT 0,
    in_app_comments INTEGER NOT NULL DEFAULT 1,
    in_app_reactions INTEGER NOT NULL DEFAULT 1,
    in_app_follows INTEGER NOT NULL DEFAULT 1,
    in_app_moderation INTEGER NOT NULL DEFAULT 1,
    email_comments INTEGER NOT NULL DEFAULT 1,
    email_reactions INTEGER NOT NULL DEFAULT 1,
    email_follows INTEGER NOT NULL DEFAULT 1,
    email_moderation INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX notificationpreference_site_id_user_id
    ON notification_preferences (site_id, user_id);
