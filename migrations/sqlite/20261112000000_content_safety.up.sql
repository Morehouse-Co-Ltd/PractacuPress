-- Content safety: sensitive words, IP rules and comment frequency limits.
--
-- Three additive tables instead of more columns on sites:
--   * sensitive_words  one editable row per word and site, with the action it takes
--                      (reject / replace / review) and its replacement placeholder;
--   * site_ip_rules    site scoped allow and deny entries, each an address or CIDR;
--   * site_safety_settings  the per-site comment window and per-user / per-IP limits.
-- A missing site_safety_settings row means the service defaults (5 per user, 10 per
-- IP, 60 second window), so existing sites need no backfill.

CREATE TABLE sensitive_words (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    word VARCHAR(100) NOT NULL,
    mode VARCHAR(20) NOT NULL DEFAULT 'reject',
    replacement VARCHAR(80) NOT NULL DEFAULT '***',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX sensitiveword_site_id_word ON sensitive_words (site_id, word);

CREATE TABLE site_ip_rules (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    value VARCHAR(64) NOT NULL,
    note VARCHAR(200) NULL,
    created_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX siteiprule_site_id_kind_value ON site_ip_rules (site_id, kind, value);

CREATE TABLE site_safety_settings (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    comment_user_limit INTEGER NOT NULL DEFAULT 5,
    comment_ip_limit INTEGER NOT NULL DEFAULT 10,
    comment_window_seconds INTEGER NOT NULL DEFAULT 60,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX sitesafetysetting_site_id ON site_safety_settings (site_id);
