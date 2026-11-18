-- Site level runtime configuration (site access limits, bound domains, frontend
-- performance switches, the loading screen and the enabled login providers).
--
-- See the sqlite change set for the rationale: one opaque JSON document plus a
-- revision per site, in its own table because the document has a public projection.
-- A timestamptz keeps the stored instant UTC on every deployment.

CREATE TABLE site_configs (
    id VARCHAR(36) PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    document TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX siteconfig_site_id ON site_configs (site_id);
