ALTER TABLE sites ADD COLUMN media_quota_bytes BIGINT NULL;
ALTER TABLE site_members ADD COLUMN media_quota_bytes BIGINT NULL;

CREATE TABLE media_quota_guards (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    serial BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY mediaquotaguard_site_id (site_id)
);
