ALTER TABLE sites ADD COLUMN media_quota_bytes INTEGER NULL;
ALTER TABLE site_members ADD COLUMN media_quota_bytes INTEGER NULL;

CREATE TABLE media_quota_guards (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    serial INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX mediaquotaguard_site_id ON media_quota_guards (site_id);
