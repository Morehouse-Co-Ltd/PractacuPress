-- Content recycle bin, per item SEO and cover, comment risk and media file name
-- (Beta 1.2).
--
-- See the sqlite change set for the rationale behind each column: content_items
-- gains the trash marker deleted_at plus the SEO overrides (seo_title,
-- seo_description, seo_keywords, canonical_url, robots), the social card and cover
-- (og_image, cover_url), and the cover presentation columns (cover_alt,
-- cover_position, cover_hidden). media_assets gains file_name and comments gains the
-- moderation ranking risk_score / risk_flags.
--
-- Types follow the rest of this dialect: DATETIME(6) NULL for the nullable instant,
-- TINYINT(1) for the boolean (BOOLEAN is only an alias for it, and DEFAULT 0 / 1 is
-- what the Ent model reads back), LONGTEXT for the three field.Text columns so a data
-- URL or a JSON array is not length limited.
--
-- MySQL has no literal DEFAULT for TEXT / BLOB columns, only an expression default
-- (MySQL 8.0.13+). The parenthesised DEFAULT ('') / DEFAULT ('[]') below is that
-- form, and it means exactly what DEFAULT '' / DEFAULT '[]' means on the other two
-- dialects. On a server older than 8.0.13 the statement is rejected instead of
-- silently storing NULL, in which case add the three columns without a default,
-- backfill them with UPDATE, and then tighten them with MODIFY NOT NULL.
--
-- Every column has a default, so existing rows keep their current behaviour: no item
-- is trashed, every SEO field inherits, no cover is configured, no comment is ranked
-- and no asset loses a name.
--
-- cover_position is the one new column whose database default is not the empty
-- string: the Ent model defaults it to "center", and a database default of '' would
-- make the reviewed SQL and the ORM disagree about rows written around the ORM
-- (imports, fixtures, manual repairs). robots keeps '' because empty is its inherit
-- value in the model too.--
-- Re-running: MySQL has neither ADD COLUMN IF NOT EXISTS nor CREATE INDEX
-- IF NOT EXISTS, so this script is applied exactly once per database, and that is
-- what the release step guarantees: the reviewed change set is a separate migration
-- step, not something the API re-applies (see migrations/README.md). A half-applied
-- run is repaired by listing the columns that are already there and issuing only the
-- missing statements:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = DATABASE() AND table_name = 'content_items'
--    ORDER BY ordinal_position
--
-- Apply this change set before deploying the API that reads these columns.

ALTER TABLE content_items ADD COLUMN deleted_at DATETIME(6) NULL;
ALTER TABLE content_items ADD COLUMN seo_title VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN seo_description VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN seo_keywords VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN canonical_url VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN og_image LONGTEXT NOT NULL DEFAULT ('');
ALTER TABLE content_items ADD COLUMN robots VARCHAR(16) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN cover_url LONGTEXT NOT NULL DEFAULT ('');
ALTER TABLE content_items ADD COLUMN cover_alt VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN cover_position VARCHAR(16) NOT NULL DEFAULT 'center';
ALTER TABLE content_items ADD COLUMN cover_hidden TINYINT(1) NOT NULL DEFAULT 0;

CREATE INDEX contentitem_site_id_deleted_at
    ON content_items (site_id, deleted_at);

ALTER TABLE media_assets ADD COLUMN file_name VARCHAR(200) NOT NULL DEFAULT '';

ALTER TABLE comments ADD COLUMN risk_score INT NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN risk_flags LONGTEXT NOT NULL DEFAULT ('[]');
