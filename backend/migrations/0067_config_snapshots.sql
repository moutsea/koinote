CREATE TABLE IF NOT EXISTS config_snapshots (
    snapshot_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              varchar(80) NOT NULL,
    file_count        integer NOT NULL CHECK (file_count > 0),
    bytes             bigint NOT NULL CHECK (bytes > 0),
    envelope_version  smallint NOT NULL CHECK (envelope_version > 0),
    envelope          bytea NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS config_snapshots_user_idx
    ON config_snapshots (user_id, created_at DESC, snapshot_id);
