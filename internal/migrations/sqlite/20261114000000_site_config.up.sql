-- Site level runtime configuration (site access limits, bound domains, frontend
-- performance switches, the loading screen and the enabled login providers).
--
-- One row per site, the same shape as site_customizations: an opaque JSON document
-- plus a revision for optimistic concurrency. It is a separate table because the
-- document has an audience split (visitors receive a projection, administrators the
-- whole document) and because it changes on a different cadence than the design.
--
-- No existing row needs a backfill: a missing row means "the site still uses the
-- browser defaults", which is exactly how every installation behaved before this
-- change set. The client writes its local settings on the next save.
--
-- Apply this change set before deploying the API that reads site_configs.

CREATE TABLE site_configs (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    document TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX siteconfig_site_id ON site_configs (site_id);
