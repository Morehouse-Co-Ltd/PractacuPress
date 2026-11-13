-- Full text search over published content (FSD C-20).
--
-- content_search is a derived read model: one row per content item with the
-- columns the feed and search pages filter on (site, kind, status, access mode,
-- category, tags, author, creation instant) plus the text to match.
--
-- Two text representations coexist on purpose. search_* keeps the readable text
-- because MySQL's ngram parser tokenizes raw CJK characters into bigrams.
-- tokens_* keeps the normalized token stream (space separated, one token per CJK
-- rune and one per Latin word) which is what SQLite FTS5 and the PostgreSQL
-- tsvector consume. Tokenizing in the application is what makes the three
-- engines return the same vocabulary for Chinese, Japanese and Korean text.
--
-- The table is not the source of truth. The review/apply path writes it after the
-- content row commits, and "go run ./apps/api/cmd/searchindex -rebuild" re-derives
-- every row after this change set has been applied, which is the backfill step for
-- items that existed before the index did.
--
-- Every column is NOT NULL with a default so the backfill can insert in any order
-- and a partially written row is still readable.

CREATE TABLE IF NOT EXISTS content_search (
    content_id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    access_mode TEXT NOT NULL,
    author_id TEXT NOT NULL,
    category_id TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    created_at_ns INTEGER NOT NULL DEFAULT 0,
    search_title TEXT NOT NULL DEFAULT '',
    search_summary TEXT NOT NULL DEFAULT '',
    search_body TEXT NOT NULL DEFAULT '',
    tokens_title TEXT NOT NULL DEFAULT '',
    tokens_summary TEXT NOT NULL DEFAULT '',
    tokens_body TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS content_search_site ON content_search (site_id, status, access_mode);

-- The FTS5 table holds the token stream, not the raw text: unicode61 already
-- splits on the spaces the application inserted, so a Chinese phrase becomes an
-- adjacent token sequence and bm25 can weight title over summary over body.
CREATE VIRTUAL TABLE IF NOT EXISTS content_search_fts USING fts5(
    content_id UNINDEXED,
    tokens_title,
    tokens_summary,
    tokens_body,
    tokenize='unicode61 remove_diacritics 2'
);
