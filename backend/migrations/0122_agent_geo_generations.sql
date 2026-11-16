-- A task/document pair owns one paid attempt. Polling and lost responses must
-- never start a second generation. The saved summary remains the source of truth.
CREATE TABLE agent_geo_generations (
 task_id uuid NOT NULL REFERENCES writing_agent_tasks(id) ON DELETE CASCADE,
 doc_id uuid NOT NULL,
 input_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('generating','saved','failed')),
 credits bigint NOT NULL DEFAULT 0,
 error_code text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,doc_id)
);
