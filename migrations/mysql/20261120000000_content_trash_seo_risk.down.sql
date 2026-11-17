-- Rollback for the Beta 1.2 content trash, SEO, cover, comment risk and media file
-- name change set. See the .up.sql file for what each column is for.
--
-- Cost and risk: this is the most expensive rollback of the three dialects. MySQL
-- rebuilds the table for each dropped column up to 8.0.29 (from 8.0.29 the server can
-- do DROP COLUMN with ALGORITHM=INSTANT, which you may append to each statement when
-- the deployment is known to be new enough) and holds a metadata lock for the
-- duration, so run it in a maintenance window on a large content_items table. The
-- values in the dropped columns are gone: trashed items return to every listing
-- because deleted_at is gone, and the per item SEO copy, the covers, the comment risk
-- scores and the asset file names are discarded. Restore from backup is the fallback
-- when those values must be kept, which is why the forward change set is additive
-- only.
--
-- The index has to go before deleted_at, and MySQL has no IF EXISTS for either
-- statement, so this rollback expects the forward change set to be fully applied and
-- is itself applied exactly once. Grouping the drops in a single ALTER TABLE per
-- table (comma separated) is the alternative when the owner prefers one table rebuild
-- instead of one per column.

ALTER TABLE content_items DROP INDEX contentitem_site_id_deleted_at;

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
