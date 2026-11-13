-- Minimal pre-migration schema for the reviewed change sets in migrations/sqlite.
-- Only the tables and columns the up/down scripts touch are present, so the
-- smoke test proves the scripts can upgrade a database created before them.
CREATE TABLE users (
    id TEXT NOT NULL PRIMARY KEY
);

CREATE TABLE user_identities (
    id TEXT NOT NULL PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    verified_at DATETIME NULL
);

CREATE TABLE audit_logs (
    id TEXT NOT NULL PRIMARY KEY,
    action TEXT NOT NULL,
    created_at DATETIME NOT NULL
);

CREATE TABLE sites (
    id TEXT NOT NULL PRIMARY KEY
);

CREATE TABLE site_members (
    id TEXT NOT NULL PRIMARY KEY
);

CREATE TABLE content_items (
    id TEXT NOT NULL PRIMARY KEY,
    -- Pre-date the read counter: the popular leaderboard index is scoped by these.
    site_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE notifications (
    id TEXT NOT NULL PRIMARY KEY,
    site_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    actor_id TEXT NULL,
    subject_id TEXT NULL,
    payload TEXT NULL,
    read_at DATETIME NULL,
    created_at DATETIME NOT NULL
);
