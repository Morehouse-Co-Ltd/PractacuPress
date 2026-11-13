-- Two-factor authentication (FSD F-04).
--
-- one row per account while an enrollment exists. The row is created disabled when
-- the account starts binding and only becomes enabled after the first valid code.
-- `secret` holds the sealed envelope (AES-256-GCM, "v1:" prefix), never the
-- plaintext base32 seed, so a database dump cannot be replayed against an
-- authenticator app.
--
-- last_used_step is the RFC 6238 time step of the newest accepted code. A login only
-- accepts a strictly newer step, which is what makes one 30 second code usable
-- exactly once inside the +/- 1 drift window.
--
-- Recovery codes are separate rows holding only a SHA-256 hash of the canonical code;
-- the plaintext list is shown once, right after enrollment or regeneration.

CREATE TABLE two_factors (
    id VARCHAR(36) PRIMARY KEY NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    secret VARCHAR(512) NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    confirmed_at DATETIME NULL,
    last_used_step INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX two_factors_user_id_key ON two_factors (user_id);
CREATE INDEX twofactor_enabled ON two_factors (enabled);

CREATE TABLE recovery_codes (
    id VARCHAR(36) PRIMARY KEY NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    code_hash VARCHAR(64) NOT NULL,
    used_at DATETIME NULL,
    created_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX recoverycode_user_id_code_hash ON recovery_codes (user_id, code_hash);
CREATE INDEX recoverycode_user_id_used_at ON recovery_codes (user_id, used_at);
