-- Short-lived, read-only access to one encrypted configuration revision.
-- Decryption keys and migration passwords never reach this table.
CREATE TABLE config_sync_grants (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot_id uuid NOT NULL REFERENCES config_snapshots(snapshot_id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision > 0),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX config_sync_grants_user_idx ON config_sync_grants(user_id, expires_at);
CREATE INDEX config_sync_grants_expiry_idx ON config_sync_grants(expires_at);
