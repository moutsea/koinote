CREATE TABLE IF NOT EXISTS agent_workspace_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE agent_workspaces DROP CONSTRAINT IF EXISTS agent_workspaces_user_id_key;
--> statement-breakpoint
ALTER TABLE agent_workspaces
    ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Default',
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_workspaces_user_idx ON agent_workspaces (user_id, id) WHERE deleted_at IS NULL;
