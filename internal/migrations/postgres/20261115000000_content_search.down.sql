-- Rollback for the derived full text index. content_items keeps every item, and
-- re-applying the up script plus "go run ./cmd/searchindex -rebuild"
-- restores the index. Dropping the table also drops the GIN and site indexes.

DROP TABLE IF EXISTS content_search;
