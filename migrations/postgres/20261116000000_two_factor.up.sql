-- Two-factor authentication (FSD F-04).
--
-- See the sqlite change set for the rationale; the tables are identical apart from
-- the dialect specific timestamp type. The secret column stores the sealed envelope
-- (AES-256-GCM, "v1:" prefix) and recovery codes store only a SHA-256 hash of the
-- canonical code.

CREATE TABLE two_factors (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    secret VARCHAR(512) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at TIMESTAMPTZ NULL,
    last_used_step BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX two_factors_user_id_key ON two_factors (user_id);
CREATE INDEX twofactor_enabled ON two_factors (enabled);

CREATE TABLE recovery_codes (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    code_hash VARCHAR(64) NOT NULL,
    used_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX recoverycode_user_id_code_hash ON recovery_codes (user_id, code_hash);
CREATE INDEX recoverycode_user_id_used_at ON recovery_codes (user_id, used_at);
