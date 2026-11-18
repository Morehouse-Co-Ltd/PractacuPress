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
-- A nullable timestamptz keeps the stored instant UTC on every deployment, as for
-- the other instants in this schema. Booleans are native BOOLEAN. og_image, cover_url
-- and risk_flags are TEXT because they hold a data URL or a JSON array and must not
-- be length limited.
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
-- Re-running: this dialect supports both ADD COLUMN IF NOT EXISTS and CREATE INDEX
-- IF NOT EXISTS, so the script is genuinely idempotent and can be re-applied after a
-- partial run. A constant DEFAULT means PostgreSQL 11+ adds each column without
-- rewriting the table, so the whole change set is a catalogue update plus one index
-- build.
--
-- Apply this change set before deploying the API that reads these columns.

ALTER TABLE content_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS seo_title VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS seo_description VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS seo_keywords VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS canonical_url VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS og_image TEXT NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS robots VARCHAR(16) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS cover_url TEXT NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS cover_alt VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS cover_position VARCHAR(16) NOT NULL DEFAULT 'center';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS cover_hidden BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS contentitem_site_id_deleted_at
    ON content_items (site_id, deleted_at);

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS file_name VARCHAR(200) NOT NULL DEFAULT '';

ALTER TABLE comments ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS risk_flags TEXT NOT NULL DEFAULT '[]';
