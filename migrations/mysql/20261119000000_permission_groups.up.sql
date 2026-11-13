-- Capability groups (user groups). See the sqlite change set for the rationale:
-- built-in rows are seeded lazily, so existing sites need no backfill and every
-- existing membership keeps deriving its group from the role.
--
-- Apply this change set before deploying the API that reads permission_groups.

ALTER TABLE site_members ADD COLUMN group_key VARCHAR(40) NOT NULL DEFAULT '';

CREATE TABLE permission_groups (
    id VARCHAR(36) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    `key` VARCHAR(40) NOT NULL,
    name VARCHAR(60) NOT NULL DEFAULT '',
    base_role VARCHAR(20) NOT NULL DEFAULT 'member',
    capabilities JSON NOT NULL,
    admin_access BOOLEAN NOT NULL DEFAULT FALSE,
    builtin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY permissiongroup_site_key (site_id, `key`),
    KEY permissiongroup_site_id (site_id)
);
