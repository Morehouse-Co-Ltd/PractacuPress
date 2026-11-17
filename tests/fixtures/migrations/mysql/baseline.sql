-- Minimal pre-migration schema for the reviewed change sets in migrations/mysql.
-- Only the tables and columns the up/down scripts touch are present, so the
-- smoke test proves the scripts can upgrade a database created before them.
CREATE TABLE users (
    id VARCHAR(36) NOT NULL PRIMARY KEY
);

CREATE TABLE user_identities (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    verified_at DATETIME(6) NULL
);

CREATE TABLE audit_logs (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    action VARCHAR(64) NOT NULL,
    created_at DATETIME(6) NOT NULL
);

CREATE TABLE sites (
    id VARCHAR(36) NOT NULL PRIMARY KEY
);

CREATE TABLE site_members (
    id VARCHAR(36) NOT NULL PRIMARY KEY
);

CREATE TABLE content_items (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    -- Pre-date the read counter: the popular leaderboard index is scoped by these.
    site_id VARCHAR(36) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'draft'
);

CREATE TABLE notifications (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    type VARCHAR(40) NOT NULL,
    actor_id VARCHAR(36) NULL,
    subject_id VARCHAR(36) NULL,
    payload JSON NULL,
    read_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL
);

-- Beta 1.2 is the first change set to touch these two tables, so the baseline has
-- to carry their pre-change shape: an id is all the up/down scripts need to add
-- columns to.
CREATE TABLE media_assets (
    id VARCHAR(36) NOT NULL PRIMARY KEY
);

CREATE TABLE comments (
    id VARCHAR(36) NOT NULL PRIMARY KEY
);

-- The page view ledger predates the reviewed change sets in this directory: no
-- versioned script creates it, so the baseline carries the pre-change shape the
-- 2026-11-21 change set needs. Only the columns that change set adds or indexes
-- matter here: the primary key plus the site_id / created_at pair.
CREATE TABLE page_views (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    created_at DATETIME(6) NOT NULL
);
