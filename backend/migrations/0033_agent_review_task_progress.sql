-- Parallel AI review tracks expose durable progress so a refresh or desktop
-- restart can resume showing what has already completed.
ALTER TABLE agent_reviews
    ADD COLUMN IF NOT EXISTS task_progress jsonb NOT NULL DEFAULT '{"completedTasks":0,"totalTasks":0,"stages":[]}'::jsonb;
