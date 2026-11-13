-- Rollback for the derived full text index. Nothing here is authoritative data:
-- content_items keeps every item, and re-applying the up script plus
-- "go run ./apps/api/cmd/searchindex -rebuild" restores the index.
--
-- Drop the FTS5 virtual table first: dropping it also removes its shadow tables
-- (content_search_fts_data, _idx, _config, _docsize).

DROP TABLE IF EXISTS content_search_fts;

DROP TABLE IF EXISTS content_search;
