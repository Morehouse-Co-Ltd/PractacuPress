-- Capability groups (user groups).
--
-- The four built-in groups (guest / member / moderator / admin / owner) are
-- seeded lazily by the service on first read, so no row needs a backfill: a site
-- with no rows behaves exactly like before this change set and adopts factory
-- defaults on first visit. `site_members.group_key` is empty for every existing
-- membership, which means "derive the group from the role". Assignment writes the
-- key and the matching role together.
--
-- Apply this change set before deploying the API that reads permission_groups.

ALTER TABLE site_members ADD COLUMN group_key VARCHAR(40) NOT NULL DEFAULT '';

CREATE TABLE permission_groups (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    key VARCHAR(40) NOT NULL,
    name VARCHAR(60) NOT NULL DEFAULT '',
    base_role VARCHAR(20) NOT NULL DEFAULT 'member',
    capabilities TEXT NOT NULL DEFAULT '[]',
    admin_access BOOLEAN NOT NULL DEFAULT 0,
    builtin BOOLEAN NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX permissiongroup_site_key ON permission_groups (site_id, key);
CREATE INDEX permissiongroup_site_id ON permission_groups (site_id);
