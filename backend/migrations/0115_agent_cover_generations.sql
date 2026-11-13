-- A task may start only one image request, even after a lost MCP response or
-- backend restart. Completed images and their charges are saved atomically in
-- agent_artifacts; this small receipt also records failed/interrupted attempts.
ALTER TABLE writing_agent_tasks ADD COLUMN cover_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE agent_cover_generations (
 task_id uuid PRIMARY KEY REFERENCES writing_agent_tasks(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating','completed','failed')),
 error_code text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
