-- Optional Skill settings apply to new bottom-panel tasks on test accounts.
-- Existing tasks and account library modes are not rewritten.
ALTER TABLE agent_session_settings ADD COLUMN auto_skills boolean NOT NULL DEFAULT true;
ALTER TABLE agent_session_settings ADD COLUMN revision bigint NOT NULL DEFAULT 1;
ALTER TABLE writing_agent_tasks ADD COLUMN skill_snapshot jsonb;

-- Keep the usage receipt after a terminal task releases its package bytes.
CREATE TABLE koi_skill_loads (
    task_id uuid NOT NULL REFERENCES writing_agent_tasks(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL,
    version_id uuid NOT NULL,
    skill_name text NOT NULL DEFAULT '',
    loaded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id,version_id)
);
