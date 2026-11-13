ALTER TABLE content_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE content_revisions (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    content_id VARCHAR(36) NOT NULL,
    version INTEGER NOT NULL,
    editor_id VARCHAR(36) NOT NULL,
    action VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT '',
    title VARCHAR(200) NOT NULL DEFAULT '',
    slug VARCHAR(120) NOT NULL DEFAULT '',
    summary VARCHAR(500) NOT NULL DEFAULT '',
    source_format VARCHAR(16) NOT NULL DEFAULT 'markdown',
    source_body TEXT NOT NULL,
    rendered_html TEXT NOT NULL DEFAULT '',
    policy_version VARCHAR(64) NOT NULL DEFAULT '',
    category_id VARCHAR(36) NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX contentrevision_content_id_version
    ON content_revisions (content_id, version);
CREATE INDEX contentrevision_site_id_content_id_version
    ON content_revisions (site_id, content_id, version);
