-- Capability groups (user groups). See the sqlite change set for the rationale:
-- built-in rows are seeded lazily, so existing sites need no backfill and every
-- existing membership keeps deriving its group from the role.

ALTER TABLE site_members ADD COLUMN group_key VARCHAR(40) NOT NULL DEFAULT '';

CREATE TABLE permission_groups (
    id VARCHAR(36) PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    key VARCHAR(40) NOT NULL,
    name VARCHAR(60) NOT NULL DEFAULT '',
    base_role VARCHAR(20) NOT NULL DEFAULT 'member',
    capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
    admin_access BOOLEAN NOT NULL DEFAULT FALSE,
    builtin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX permissiongroup_site_key ON permission_groups (site_id, key);
CREATE INDEX permissiongroup_site_id ON permission_groups (site_id);
