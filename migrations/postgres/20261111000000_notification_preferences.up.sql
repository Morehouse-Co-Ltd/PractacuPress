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
    id VARCHAR(36) PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    in_app_comments BOOLEAN NOT NULL DEFAULT TRUE,
    in_app_reactions BOOLEAN NOT NULL DEFAULT TRUE,
    in_app_follows BOOLEAN NOT NULL DEFAULT TRUE,
    in_app_moderation BOOLEAN NOT NULL DEFAULT TRUE,
    email_comments BOOLEAN NOT NULL DEFAULT TRUE,
    email_reactions BOOLEAN NOT NULL DEFAULT TRUE,
    email_follows BOOLEAN NOT NULL DEFAULT TRUE,
    email_moderation BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX notificationpreference_site_id_user_id
    ON notification_preferences (site_id, user_id);
