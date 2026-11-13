-- OAuth sign-in state (single use authorization requests).
--
-- See the sqlite change set for the rationale: one row per pending authorization
-- request, keyed by the state value the provider echoes back, carrying the PKCE
-- verifier, the local redirect target, an expiry and the consumption timestamp that
-- makes the row one-shot. A timestamptz keeps the stored instant UTC on every
-- deployment, and the index on expires_at serves the sweeper.

CREATE TABLE oauth_states (
    state VARCHAR(128) PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    redirect_target VARCHAR(2048) NULL,
    code_verifier VARCHAR(128) NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ NULL
);

CREATE INDEX oauthstate_expires_at ON oauth_states (expires_at);
