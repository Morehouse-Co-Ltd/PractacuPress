-- Full text search over published content (FSD C-20).
--
-- See the sqlite change set for the rationale: content_search is a derived read
-- model that keeps both the readable text (search_*) and the application
-- tokenized stream (tokens_*), because the three engines tokenize CJK text
-- differently.
--
-- PostgreSQL matches on a stored tsvector built from the tokenized columns with
-- the 'simple' configuration: the application already removed stop words and
-- lower cased, and 'simple' never stems, so a mixed Chinese/Latin term stays
-- predictable. to_tsvector(regconfig, text) is immutable, which is what allows the
-- generated column and the GIN index. The weights let ts_rank_cd prefer a title
-- hit over a body hit.
--
-- The tsvector column is generated: it is never written by the application, so an
-- index write only updates the three token columns and the vector follows.
-- The backfill is the same command as the other dialects:
-- go run ./apps/api/cmd/searchindex -rebuild.

CREATE TABLE IF NOT EXISTS content_search (
    content_id VARCHAR(64) PRIMARY KEY,
    site_id VARCHAR(64) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    status VARCHAR(32) NOT NULL,
    access_mode VARCHAR(16) NOT NULL,
    author_id VARCHAR(64) NOT NULL,
    category_id VARCHAR(64) NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    created_at_ns BIGINT NOT NULL DEFAULT 0,
    search_title TEXT NOT NULL DEFAULT '',
    search_summary TEXT NOT NULL DEFAULT '',
    search_body TEXT NOT NULL DEFAULT '',
    tokens_title TEXT NOT NULL DEFAULT '',
    tokens_summary TEXT NOT NULL DEFAULT '',
    tokens_body TEXT NOT NULL DEFAULT '',
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', tokens_title), 'A') ||
        setweight(to_tsvector('simple', tokens_summary), 'B') ||
        setweight(to_tsvector('simple', tokens_body), 'C')
    ) STORED
);

CREATE INDEX IF NOT EXISTS content_search_vector ON content_search USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS content_search_site ON content_search (site_id, status, access_mode);
