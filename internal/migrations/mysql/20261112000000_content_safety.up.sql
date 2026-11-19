-- Content safety: sensitive words, IP rules and comment frequency limits.
--
-- See the sqlite change set for the rationale; the tables are identical apart from
-- the dialect specific timestamp type and primary key syntax. A missing
-- site_safety_settings row means the service defaults (5 per user, 10 per IP,
-- 60 second window), so existing sites need no backfill.

CREATE TABLE sensitive_words (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    word VARCHAR(100) NOT NULL,
    mode VARCHAR(20) NOT NULL DEFAULT 'reject',
    replacement VARCHAR(80) NOT NULL DEFAULT '***',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY sensitiveword_site_id_word (site_id, word)
);

CREATE TABLE site_ip_rules (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    value VARCHAR(64) NOT NULL,
    note VARCHAR(200) NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY siteiprule_site_id_kind_value (site_id, kind, value)
);

CREATE TABLE site_safety_settings (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    comment_user_limit INT NOT NULL DEFAULT 5,
    comment_ip_limit INT NOT NULL DEFAULT 10,
    comment_window_seconds INT NOT NULL DEFAULT 60,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY sitesafetysetting_site_id (site_id)
);
