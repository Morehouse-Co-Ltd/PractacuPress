-- Rollback for the Beta 1.2 content trash, SEO, cover, comment risk and media file
-- name change set. See the .up.sql file for what each column is for.
--
-- The index has to go before deleted_at: SQLite refuses to drop a column that an
-- index still references. Everything else here is a plain column drop.
--
-- Cost and risk: ALTER TABLE DROP COLUMN is available from SQLite 3.35 and rewrites
-- the table (modernc.org/sqlite, the driver this repository builds, bundles a much
-- newer engine). Trashed items come back into every listing because deleted_at is
-- gone, and the per item SEO copy, the covers, the comment risk scores and the asset
-- file names are discarded. Restore from backup is the fallback when those values
-- must be kept, which is why the forward change set is additive only.
--
-- Applied exactly once, like the up script: SQLite has no DROP COLUMN IF EXISTS.

DROP INDEX IF EXISTS contentitem_site_id_deleted_at;

ALTER TABLE content_items DROP COLUMN cover_hidden;
ALTER TABLE content_items DROP COLUMN cover_position;
ALTER TABLE content_items DROP COLUMN cover_alt;
ALTER TABLE content_items DROP COLUMN cover_url;
ALTER TABLE content_items DROP COLUMN robots;
ALTER TABLE content_items DROP COLUMN og_image;
ALTER TABLE content_items DROP COLUMN canonical_url;
ALTER TABLE content_items DROP COLUMN seo_keywords;
ALTER TABLE content_items DROP COLUMN seo_description;
ALTER TABLE content_items DROP COLUMN seo_title;
ALTER TABLE content_items DROP COLUMN deleted_at;

ALTER TABLE media_assets DROP COLUMN file_name;

ALTER TABLE comments DROP COLUMN risk_flags;
ALTER TABLE comments DROP COLUMN risk_score;
