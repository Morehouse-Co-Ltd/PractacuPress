-- OAuth sign-in state (single use authorization requests).
--
-- See the sqlite change set for the rationale: one row per pending authorization
-- request, keyed by the state value the provider echoes back, carrying the PKCE
-- verifier, the local redirect target, an expiry and the consumption timestamp that
-- makes the row one-shot. The index on expires_at serves the sweeper.

CREATE TABLE oauth_states (
    state VARCHAR(128) NOT NULL,
    site_id VARCHAR(36) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    redirect_target VARCHAR(2048) NULL,
    code_verifier VARCHAR(128) NULL,
    created_at DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    consumed_at DATETIME(6) NULL,
    PRIMARY KEY (state),
    KEY oauthstate_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
