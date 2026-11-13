-- Minimal pre-migration schema for the reviewed change sets in migrations/postgres.
-- Only the tables and columns the up/down scripts touch are present, so the
-- smoke test proves the scripts can upgrade a database created before them.
CREATE TABLE users (
    id VARCHAR(36) NOT NULL PRIMARY KEY
);

CREATE TABLE user_identities (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    verified_at TIMESTAMPTZ NULL
);

CREATE TABLE audit_logs (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    action VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
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
    payload JSONB NULL,
    read_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL
);
