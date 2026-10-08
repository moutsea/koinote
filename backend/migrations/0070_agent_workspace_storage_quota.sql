CREATE TABLE IF NOT EXISTS agent_workspace_storage_quotas (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bonus_bytes BIGINT NOT NULL DEFAULT 0 CHECK (bonus_bytes >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
