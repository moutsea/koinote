CREATE TABLE agent_session_settings (
 user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 permission text NOT NULL DEFAULT 'review' CHECK(permission IN ('review','assist','full'))
);
CREATE TABLE agent_sessions (
 id uuid PRIMARY KEY,
 user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL DEFAULT '新会话',
 permission text NOT NULL DEFAULT 'review' CHECK(permission IN ('review','assist','full')),
 revision bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz
);
CREATE INDEX agent_sessions_user ON agent_sessions(user_id, updated_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE writing_agent_tasks ADD COLUMN session_id uuid REFERENCES agent_sessions(id);
ALTER TABLE writing_agent_tasks ADD COLUMN storage_budget_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE writing_agent_tasks ADD COLUMN permission_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE writing_agent_tasks ADD COLUMN advice_only boolean NOT NULL DEFAULT false;
CREATE INDEX writing_agent_tasks_session ON writing_agent_tasks(session_id,created_at DESC);
CREATE UNIQUE INDEX agent_session_running ON writing_agent_tasks(session_id) WHERE session_id IS NOT NULL AND status NOT IN ('completed','failed','cancelled');

CREATE TABLE agent_document_reads (
 task_id uuid NOT NULL REFERENCES writing_agent_tasks(id) ON DELETE CASCADE,
 doc_id text NOT NULL,
 snapshot jsonb NOT NULL,
 PRIMARY KEY(task_id,doc_id)
);
CREATE TABLE agent_operations (
 id uuid PRIMARY KEY,
 task_id uuid NOT NULL REFERENCES writing_agent_tasks(id) ON DELETE CASCADE,
 user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_key text NOT NULL,
 input_hash text NOT NULL,
 input jsonb NOT NULL,
 before_state jsonb,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected','cancelled','superseded','undone')),
 approval text NOT NULL DEFAULT '',
 reason text NOT NULL DEFAULT '',
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,request_key)
);
CREATE INDEX agent_operations_user ON agent_operations(user_id,task_id);

CREATE FUNCTION agent_task_storage_bytes(task uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT (octet_length(t.message)+octet_length(t.source::text)+octet_length(t.result)+octet_length(t.error)
 +COALESCE((SELECT SUM(octet_length(snapshot::text)) FROM agent_document_reads WHERE task_id=t.id),0)
 +COALESCE((SELECT SUM(octet_length(input::text)+COALESCE(octet_length(before_state::text),0)+COALESCE(octet_length(result::text),0)+octet_length(reason)) FROM agent_operations WHERE task_id=t.id),0))::bigint
 FROM writing_agent_tasks t WHERE t.id=task
$$;
CREATE FUNCTION agent_session_storage_bytes(owner_id integer) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT (COALESCE((SELECT SUM(octet_length(title)) FROM agent_sessions WHERE user_id=owner_id AND deleted_at IS NULL),0)
 +COALESCE((SELECT SUM(GREATEST(agent_task_storage_bytes(t.id),t.storage_budget_bytes))
 FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.user_id=owner_id AND s.deleted_at IS NULL),0))::bigint
$$;
