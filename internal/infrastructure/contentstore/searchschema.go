package contentstore

import (
	"strconv"
	"strings"
)

// searchColumns is the column order shared by every dialect and by the upsert
// statements below. The raw search_* columns feed MySQL's ngram FULLTEXT index;
// the tokens_* columns feed SQLite FTS5 and the PostgreSQL tsvector. The two
// representations coexist because the engines tokenize CJK text differently.
const searchColumns = "content_id, site_id, kind, status, access_mode, author_id, " +
	"category_id, tags, created_at_ns, search_title, search_summary, search_body, " +
	"tokens_title, tokens_summary, tokens_body"

const searchUpdateColumns = "site_id, kind, status, access_mode, author_id, " +
	"category_id, tags, created_at_ns, search_title, search_summary, search_body, " +
	"tokens_title, tokens_summary, tokens_body"

// searchSchemaStatements mirrors migrations/*/20261115000000_content_search.up.sql.
//
// It runs with IF NOT EXISTS, so the reviewed migration stays the source of
// truth for production and this is only the developer/test safety net (Ent's
// Schema.Create does not know about the index). Every statement must stay
// idempotent and single-statement: the reviewed migration runner splits scripts
// on semicolons, and the portable subset is what lets one code path serve three
// dialects.
//
// Keep the column list and the types identical to the migration. A database that
// gets this DDL first (a test or a fresh developer machine) must be
// indistinguishable from one that applied the reviewed change set.
func searchSchemaStatements(dialect searchDialect) []string {
	switch dialect {
	case searchMySQL:
		return []string{`CREATE TABLE IF NOT EXISTS content_search (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`}

	case searchPostgres:
		return []string{
			`CREATE TABLE IF NOT EXISTS content_search (
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
)`,
			`CREATE INDEX IF NOT EXISTS content_search_vector ON content_search USING GIN (search_vector)`,
			`CREATE INDEX IF NOT EXISTS content_search_site ON content_search (site_id, status, access_mode)`,
		}

	default:
		return []string{
			`CREATE TABLE IF NOT EXISTS content_search (
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
)`,
			`CREATE INDEX IF NOT EXISTS content_search_site ON content_search (site_id, status, access_mode)`,
			`CREATE VIRTUAL TABLE IF NOT EXISTS content_search_fts USING fts5(
	content_id UNINDEXED,
	tokens_title,
	tokens_summary,
	tokens_body,
	tokenize='unicode61 remove_diacritics 2'
)`,
		}
	}
}

// upsertSearchSQL builds the idempotent index write for the active dialect.
func (s *Store) upsertSearchSQL() string {
	placeholders := make([]string, 0, 15)
	for i := 0; i < 15; i++ {
		if s.searchDialect() == searchPostgres {
			placeholders = append(placeholders, "$"+strconv.Itoa(i+1))
		} else {
			placeholders = append(placeholders, "?")
		}
	}

	updates := make([]string, 0, 14)
	for _, column := range strings.Split(searchUpdateColumns, ", ") {
		if s.searchDialect() == searchMySQL {
			updates = append(updates, column+" = VALUES("+column+")")
		} else {
			updates = append(updates, column+" = excluded."+column)
		}
	}

	if s.searchDialect() == searchMySQL {
		return "INSERT INTO content_search (" + searchColumns + ") VALUES (" +
			strings.Join(placeholders, ", ") + ") ON DUPLICATE KEY UPDATE " +
			strings.Join(updates, ", ")
	}
	return "INSERT INTO content_search (" + searchColumns + ") VALUES (" +
		strings.Join(placeholders, ", ") + ") ON CONFLICT (content_id) DO UPDATE SET " +
		strings.Join(updates, ", ")
}
