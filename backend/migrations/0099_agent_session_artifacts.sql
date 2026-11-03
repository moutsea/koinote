ALTER TABLE writing_agent_tasks ADD COLUMN conversation_task boolean NOT NULL DEFAULT false;
UPDATE writing_agent_tasks SET conversation_task=true WHERE session_id IS NOT NULL;

-- Preserve existing single-document tasks in the unified history, with their
-- original MCP contract and mandatory human approval.
INSERT INTO agent_sessions(id,user_id,title,permission,created_at,updated_at)
SELECT id,user_id,COALESCE(NULLIF(left(message,40),''),'写作任务'),'review',created_at,updated_at
FROM writing_agent_tasks WHERE session_id IS NULL;
UPDATE writing_agent_tasks SET session_id=id,source=source||jsonb_build_object('path','/documents/'||doc_id) WHERE session_id IS NULL;

CREATE TABLE agent_artifacts (
 id uuid PRIMARY KEY,
 task_id uuid NOT NULL REFERENCES writing_agent_tasks(id) ON DELETE CASCADE,
 user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL,
 mime_type text NOT NULL,
 digest text NOT NULL,
 data bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,name),
 CHECK(octet_length(data)<=1048576)
);
CREATE OR REPLACE FUNCTION agent_task_storage_bytes(task uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT (octet_length(t.message)+octet_length(t.source::text)+octet_length(t.result)+octet_length(t.error)
 +COALESCE(octet_length(t.proposal::text),0)
 +COALESCE((SELECT SUM(octet_length(snapshot::text)) FROM agent_document_reads WHERE task_id=t.id),0)
 +COALESCE((SELECT SUM(octet_length(input::text)+COALESCE(octet_length(before_state::text),0)+COALESCE(octet_length(result::text),0)+octet_length(reason)) FROM agent_operations WHERE task_id=t.id),0)
 +COALESCE((SELECT SUM(octet_length(data)+octet_length(name)+octet_length(mime_type)) FROM agent_artifacts WHERE task_id=t.id),0))::bigint
 FROM writing_agent_tasks t WHERE t.id=task
$$;

CREATE VIEW agent_session_image_contents AS
 SELECT t.user_id,t.session_id,t.source->>'content' AS content FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,t.proposal->>'content' FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL AND t.proposal IS NOT NULL
 UNION ALL SELECT t.user_id,t.session_id,r.snapshot->'document'->>'content' FROM agent_document_reads r JOIN writing_agent_tasks t ON t.id=r.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,o.input->>'content' FROM agent_operations o JOIN writing_agent_tasks t ON t.id=o.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,o.before_state->'document'->>'content' FROM agent_operations o JOIN writing_agent_tasks t ON t.id=o.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL;
