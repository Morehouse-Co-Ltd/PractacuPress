-- Rollback for the Beta 1.2 content trash, SEO, cover, comment risk and media file
-- name change set. See the .up.sql file for what each column is for.
--
-- Every statement is guarded, so the rollback can be re-applied after a partial run
-- and is a no-op on a database that never received the forward change set.
--
-- Cost and risk: DROP COLUMN needs a short ACCESS EXCLUSIVE lock and only marks the
-- attribute as dropped, so the table is not rewritten and the old values stay in the
-- files until they are vacuumed. What it does destroy is the meaning of the data:
-- trashed items return to every listing because deleted_at is gone, and the per item
-- SEO copy, the covers, the comment risk scores and the asset file names are no
-- longer readable. Restore from backup is the fallback when those values must be
-- kept, which is why the forward change set is additive only.

DROP INDEX IF EXISTS contentitem_site_id_deleted_at;

ALTER TABLE content_items DROP COLUMN IF EXISTS cover_hidden;
ALTER TABLE content_items DROP COLUMN IF EXISTS cover_position;
ALTER TABLE content_items DROP COLUMN IF EXISTS cover_alt;
ALTER TABLE content_items DROP COLUMN IF EXISTS cover_url;
ALTER TABLE content_items DROP COLUMN IF EXISTS robots;
ALTER TABLE content_items DROP COLUMN IF EXISTS og_image;
ALTER TABLE content_items DROP COLUMN IF EXISTS canonical_url;
ALTER TABLE content_items DROP COLUMN IF EXISTS seo_keywords;
ALTER TABLE content_items DROP COLUMN IF EXISTS seo_description;
ALTER TABLE content_items DROP COLUMN IF EXISTS seo_title;
ALTER TABLE content_items DROP COLUMN IF EXISTS deleted_at;

ALTER TABLE media_assets DROP COLUMN IF EXISTS file_name;

ALTER TABLE comments DROP COLUMN IF EXISTS risk_flags;
ALTER TABLE comments DROP COLUMN IF EXISTS risk_score;
