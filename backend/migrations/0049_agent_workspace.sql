CREATE TABLE IF NOT EXISTS agent_workspaces (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    revision    BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_workspace_files (
    id              BIGSERIAL PRIMARY KEY,
    workspace_id    BIGINT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    content         BYTEA NOT NULL,
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes      BIGINT NOT NULL CHECK (size_bytes >= 0),
    sha256          TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, path)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_workspace_files_workspace_idx
    ON agent_workspace_files (workspace_id, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_workspace_events (
    id           BIGSERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id BIGINT REFERENCES agent_workspaces(id) ON DELETE SET NULL,
    action       TEXT NOT NULL,
    revision     BIGINT,
    file_count   INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_workspace_events_user_idx
    ON agent_workspace_events (user_id, created_at DESC);
