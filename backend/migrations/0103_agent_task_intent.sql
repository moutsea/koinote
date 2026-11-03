-- Existing tasks retain the legacy protocol; new conversation messages opt in.
ALTER TABLE agent_sessions ADD COLUMN intent_version bigint NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN intent_message_id text NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN intent_state jsonb;
ALTER TABLE writing_agent_tasks ADD COLUMN intent_version bigint NOT NULL DEFAULT 0;
ALTER TABLE writing_agent_tasks ADD COLUMN intent_state jsonb;
ALTER TABLE writing_agent_tasks ADD COLUMN intent_result jsonb;
CREATE UNIQUE INDEX writing_agent_intent_version ON writing_agent_tasks(session_id,intent_version) WHERE intent_version>0;

CREATE OR REPLACE FUNCTION agent_task_storage_bytes(task uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT (COALESCE(octet_length(t.intent_state::text),0)+COALESCE(octet_length(t.intent_result::text),0)+octet_length(t.message)+octet_length(t.source::text)+octet_length(t.result)+octet_length(t.error)
 +COALESCE(octet_length(t.proposal::text),0)
 +COALESCE((SELECT SUM(octet_length(snapshot::text)) FROM agent_document_reads WHERE task_id=t.id),0)
 +COALESCE((SELECT SUM(octet_length(input::text)+COALESCE(octet_length(before_state::text),0)+COALESCE(octet_length(result::text),0)+octet_length(reason)) FROM agent_operations WHERE task_id=t.id),0)
 +COALESCE((SELECT SUM(octet_length(data)+octet_length(name)+octet_length(mime_type)) FROM agent_artifacts WHERE task_id=t.id),0))::bigint
 FROM writing_agent_tasks t WHERE t.id=task
$$;
CREATE OR REPLACE FUNCTION agent_session_storage_bytes(owner_id integer) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT (COALESCE((SELECT SUM(octet_length(title)+COALESCE(octet_length(intent_state::text),0)) FROM agent_sessions WHERE user_id=owner_id AND deleted_at IS NULL),0)
 +COALESCE((SELECT SUM(GREATEST(agent_task_storage_bytes(t.id),t.storage_budget_bytes))
 FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.user_id=owner_id AND s.deleted_at IS NULL),0))::bigint
$$;
