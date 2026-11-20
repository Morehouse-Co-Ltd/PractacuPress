-- Rollback for the derived full text index. content_items keeps every item, and
-- re-applying the up script plus "go run ./cmd/searchindex -rebuild"
-- restores the index. Dropping the table also drops the FULLTEXT and site keys.

DROP TABLE IF EXISTS content_search;
