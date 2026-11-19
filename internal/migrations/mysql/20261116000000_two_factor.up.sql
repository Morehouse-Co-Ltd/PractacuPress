-- Two-factor authentication (FSD F-04).
--
-- See the sqlite change set for the rationale; the tables are identical apart from
-- the dialect specific timestamp type and primary key syntax. The secret column
-- stores the sealed envelope (AES-256-GCM, "v1:" prefix) and recovery codes store
-- only a SHA-256 hash of the canonical code.

CREATE TABLE two_factors (
    id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    secret VARCHAR(512) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 0,
    confirmed_at DATETIME(6) NULL,
    last_used_step BIGINT NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY two_factors_user_id_key (user_id),
    KEY twofactor_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE recovery_codes (
    id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    code_hash VARCHAR(64) NOT NULL,
    used_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY recoverycode_user_id_code_hash (user_id, code_hash),
    KEY recoverycode_user_id_used_at (user_id, used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
