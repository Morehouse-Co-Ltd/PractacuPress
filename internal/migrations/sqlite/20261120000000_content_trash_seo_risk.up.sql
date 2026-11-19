-- Content recycle bin, per item SEO and cover, comment risk and media file name
-- (Beta 1.2).
--
-- content_items gains the trash marker and the item level presentation columns:
--   * deleted_at  the recycle bin marker. A soft delete is the only delete this
--                 model offers, so the row keeps its revisions, comments and media
--                 references resolvable. Every reader filters deleted_at IS NULL,
--                 which is why the same change set adds (site_id, deleted_at).
--   * seo_title / seo_description / seo_keywords / canonical_url / robots
--                 per item overrides of the site wide SEO template. Empty means
--                 "inherit": an item that never touches these fields behaves
--                 exactly as before this change set.
--   * og_image / cover_url
--                 the social card and the cover. Both are TEXT rather than a length
--                 limited type because they accept a data URL, which a bounded
--                 VARCHAR would truncate or reject.
--   * cover_alt / cover_position / cover_hidden
--                 the cover accessibility text, the crop anchor and the switch that
--                 hides the cover on the public page without deleting it.
-- media_assets.file_name keeps the name the uploader used. The library used to
-- render a fragment of the storage key because the column did not exist.
-- comments.risk_score / risk_flags carry the server side moderation ranking (an
-- integer score plus the JSON array of reasons), which used to be computed in the
-- browser and therefore depended on the device that opened the queue.
--
-- Every column has a default, so existing rows keep their current behaviour: no
-- item is trashed, every SEO field inherits, no cover is configured, no comment is
-- ranked and no asset loses a name. Column types follow the Ent model: booleans are
-- stored as INTEGER 0/1 and instants as DATETIME text.
--
-- cover_position is the one new column whose database default is not the empty
-- string: the Ent model defaults it to "center", and a database default of '' would
-- make the reviewed SQL and the ORM disagree about rows written around the ORM
-- (imports, fixtures, manual repairs). robots keeps '' because empty is its inherit
-- value in the model too.
--
-- Re-running: SQLite has no ADD COLUMN IF NOT EXISTS, so this script is applied
-- exactly once per database. That is what the release step guarantees: the reviewed
-- change set is a separate migration step, not something the API re-applies (see
-- migrations/README.md). Because the sqlite3 shell keeps going after a failed
-- statement, a half-applied run is repaired by listing the columns that are already
-- there and issuing only the missing statements:
--   sqlite3 data/practacu.db "PRAGMA table_info(content_items)"
-- The index statement is IF NOT EXISTS, so the index half can be re-issued safely.
--
-- Apply this change set before deploying the API that reads these columns.

ALTER TABLE content_items ADD COLUMN deleted_at DATETIME NULL;
ALTER TABLE content_items ADD COLUMN seo_title VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN seo_description VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN seo_keywords VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN canonical_url VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN og_image TEXT NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN robots VARCHAR(16) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN cover_url TEXT NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN cover_alt VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN cover_position VARCHAR(16) NOT NULL DEFAULT 'center';
ALTER TABLE content_items ADD COLUMN cover_hidden INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS contentitem_site_id_deleted_at
    ON content_items (site_id, deleted_at);

ALTER TABLE media_assets ADD COLUMN file_name VARCHAR(200) NOT NULL DEFAULT '';

ALTER TABLE comments ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN risk_flags TEXT NOT NULL DEFAULT '[]';
