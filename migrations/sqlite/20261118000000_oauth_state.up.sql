-- OAuth sign-in state (single use authorization requests).
--
-- One row per pending authorization request. `state` is the random value the
-- provider echoes back on the callback, so it is also the primary key: the callback
-- looks the row up by that value alone and never needs an internal id.
--
-- `code_verifier` holds the PKCE verifier for this attempt; only its challenge leaves
-- the server inside the authorization URL. `redirect_target` is the local page to
-- return to once the callback succeeds, so the flow survives a browser reload.
--
-- `consumed_at` makes the row one-shot: the callback stamps the column when it
-- exchanges the code and a second callback carrying the same state is rejected as a
-- replay. The row is kept instead of deleted so that replay is recognisable rather
-- than looking like an unknown state.
--
-- `expires_at` bounds the flow, and the index lets the sweeper remove expired rows
-- without scanning the table.

CREATE TABLE oauth_states (
    state VARCHAR(128) NOT NULL PRIMARY KEY,
    site_id VARCHAR(36) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    redirect_target VARCHAR(2048) NULL,
    code_verifier VARCHAR(128) NULL,
    created_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME NULL
);

CREATE INDEX oauthstate_expires_at ON oauth_states (expires_at);
