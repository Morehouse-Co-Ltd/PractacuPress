-- Personal reading history: one row per user and content target.
--
-- The page view table stores an anonymous session id, which cannot be turned back
-- into an account, so the signed-in reading history needs its own dimension. The
-- unique key lets the write path upsert a visit instead of growing a row per reload.
CREATE TABLE reading_histories (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    target_type VARCHAR(20) NOT NULL,
    target_id VARCHAR(36) NOT NULL,
    last_viewed_at DATETIME(6) NOT NULL,
    view_count INT NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY readinghistory_user_id_target_type_target_id (user_id, target_type, target_id),
    KEY readinghistory_site_id_user_id_last_viewed_at (site_id, user_id, last_viewed_at)
);
