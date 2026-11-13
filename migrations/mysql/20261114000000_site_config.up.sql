-- Site level runtime configuration (site access limits, bound domains, frontend
-- performance switches, the loading screen and the enabled login providers).
--
-- See the sqlite change set for the rationale: one opaque JSON document plus a
-- revision per site, in its own table because the document has a public projection.
-- LONGTEXT matches the Ent model (field.Text); the service caps the document at
-- 64 KiB, well below the column limit.

CREATE TABLE site_configs (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    document LONGTEXT NOT NULL,
    revision INT NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY siteconfig_site_id (site_id)
);
