-- System curation is an ownership scope, not a personal account or quota bonus.
ALTER TABLE agent_workspaces
    ALTER COLUMN user_id DROP NOT NULL,
    ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT agent_workspace_owner_scope CHECK (is_system = (user_id IS NULL));
CREATE UNIQUE INDEX agent_workspace_system_import_request_idx
    ON agent_workspaces(github_import_request_id) WHERE is_system;

CREATE TABLE agent_repository_system_events (
    id BIGSERIAL PRIMARY KEY,
    workspace_id BIGINT REFERENCES agent_workspaces(id) ON DELETE SET NULL,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN ('adopt','import','publish','unpublish')),
    revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
