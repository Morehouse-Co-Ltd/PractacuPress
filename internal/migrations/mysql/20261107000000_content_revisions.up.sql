ALTER TABLE content_items ADD COLUMN revision INT NOT NULL DEFAULT 0;

CREATE TABLE content_revisions (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    content_id VARCHAR(36) NOT NULL,
    version INT NOT NULL,
    editor_id VARCHAR(36) NOT NULL,
    action VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT '',
    title VARCHAR(200) NOT NULL DEFAULT '',
    slug VARCHAR(120) NOT NULL DEFAULT '',
    summary VARCHAR(500) NOT NULL DEFAULT '',
    source_format VARCHAR(16) NOT NULL DEFAULT 'markdown',
    source_body LONGTEXT NOT NULL,
    rendered_html LONGTEXT NOT NULL,
    policy_version VARCHAR(64) NOT NULL DEFAULT '',
    category_id VARCHAR(36) NULL,
    tags LONGTEXT NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY contentrevision_content_id_version (content_id, version),
    KEY contentrevision_site_id_content_id_version (site_id, content_id, version)
);
