CREATE TABLE writing_agent_tasks (
 id uuid PRIMARY KEY,
 user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 doc_id text NOT NULL,
 request_key uuid NOT NULL,
 input_hash text NOT NULL,
 message text NOT NULL,
 source jsonb NOT NULL,
 skill jsonb NOT NULL,
 workspace_id text NOT NULL DEFAULT '',
 job_id text NOT NULL DEFAULT '',
 remote_input jsonb,
 status text NOT NULL DEFAULT 'preparing',
 result text NOT NULL DEFAULT '',
 error text NOT NULL DEFAULT '',
 proposal jsonb,
 applied_document jsonb,
 reservation_id text NOT NULL,
 reserved_credits bigint NOT NULL,
 charged_credits bigint NOT NULL DEFAULT 0,
 usage jsonb,
 billing_status text NOT NULL DEFAULT 'reserved',
 cursor bigint NOT NULL DEFAULT 0,
 cancel_requested boolean NOT NULL DEFAULT false,
 lease_until timestamptz NOT NULL DEFAULT '-infinity',
 next_poll_at timestamptz NOT NULL DEFAULT now(),
 deadline timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id, request_key)
);
CREATE INDEX writing_agent_tasks_user ON writing_agent_tasks(user_id, created_at DESC);
CREATE INDEX writing_agent_tasks_poll ON writing_agent_tasks(next_poll_at) WHERE status NOT IN ('completed','failed','cancelled');
CREATE TABLE writing_agent_events (
 task_id uuid NOT NULL REFERENCES writing_agent_tasks(id) ON DELETE CASCADE,
 seq bigint NOT NULL,
 event jsonb NOT NULL,
 PRIMARY KEY(task_id, seq)
);
CREATE TABLE writing_agent_deliveries (
 task_id uuid NOT NULL REFERENCES writing_agent_tasks(id) ON DELETE CASCADE,
 delivery_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id, delivery_id)
);
