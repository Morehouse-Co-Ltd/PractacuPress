-- Full text search over published content (FSD C-20).
--
-- See the sqlite change set for the rationale: content_search is a derived read
-- model that keeps both the readable text (search_*) and the application
-- tokenized stream (tokens_*), because the three engines tokenize CJK text
-- differently.
--
-- MySQL matches on the readable columns through a FULLTEXT index built with the
-- ngram parser, which is what makes Chinese work without a word segmenter. The
-- ngram parser is a built in plugin in MySQL 5.7+ and MariaDB 10.0.5+; on a server
-- where it is unavailable the CREATE TABLE fails, the API logs the cause and
-- search degrades to the portable LIKE path, so a deployment without ngram still
-- works instead of losing the endpoint.
--
-- ngram_token_size stays at its default of 2, which is why the API requires a
-- term of at least two characters. The backfill is the same command as the other
-- dialects: go run ./apps/api/cmd/searchindex -rebuild.

CREATE TABLE IF NOT EXISTS content_search (
    content_id VARCHAR(64) NOT NULL,
    site_id VARCHAR(64) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    status VARCHAR(32) NOT NULL,
    access_mode VARCHAR(16) NOT NULL,
    author_id VARCHAR(64) NOT NULL,
    category_id VARCHAR(64) NOT NULL DEFAULT '',
    tags TEXT NOT NULL,
    created_at_ns BIGINT NOT NULL DEFAULT 0,
    search_title TEXT NOT NULL,
    search_summary TEXT NOT NULL,
    search_body MEDIUMTEXT NOT NULL,
    tokens_title TEXT NOT NULL,
    tokens_summary TEXT NOT NULL,
    tokens_body MEDIUMTEXT NOT NULL,
    PRIMARY KEY (content_id),
    KEY content_search_site (site_id, status, access_mode),
    FULLTEXT KEY content_search_fulltext (search_title, search_summary, search_body) WITH PARSER ngram
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
