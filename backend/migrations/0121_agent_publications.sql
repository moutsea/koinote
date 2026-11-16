-- Publishing is always a separate, explicit user decision, independent of
-- document-edit permissions. Claim before network I/O; never resend a claim.
CREATE TABLE agent_publications (
 id uuid PRIMARY KEY,
 task_id uuid NOT NULL REFERENCES writing_agent_tasks(id) ON DELETE CASCADE,
 user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 doc_id uuid NOT NULL,
 revision bigint NOT NULL,
 channel text NOT NULL CHECK(channel IN ('wechat','x','custom')),
 target_id text NOT NULL,
 target_label text NOT NULL,
 input_hash text NOT NULL,
 snapshot jsonb NOT NULL,
 credits bigint NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','uncertain','rejected')),
 result_url text NOT NULL DEFAULT '',
 result_id text NOT NULL DEFAULT '',
 error_code text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,doc_id,channel,target_id)
);
CREATE INDEX agent_publications_owner ON agent_publications(user_id,doc_id,channel,target_id);

CREATE OR REPLACE FUNCTION agent_task_storage_bytes(task uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT (COALESCE(octet_length(t.intent_state::text),0)+COALESCE(octet_length(t.intent_result::text),0)+octet_length(t.message)+octet_length(t.source::text)+octet_length(t.result)+octet_length(t.error)
 +COALESCE(octet_length(t.proposal::text),0)
 +COALESCE((SELECT SUM(octet_length(snapshot::text)) FROM agent_document_reads WHERE task_id=t.id),0)
 +COALESCE((SELECT SUM(octet_length(input::text)+COALESCE(octet_length(before_state::text),0)+COALESCE(octet_length(result::text),0)+octet_length(reason)) FROM agent_operations WHERE task_id=t.id),0)
 +COALESCE((SELECT SUM(octet_length(data)+octet_length(name)+octet_length(mime_type)) FROM agent_artifacts WHERE task_id=t.id),0)
 +COALESCE((SELECT SUM(octet_length(snapshot::text)+octet_length(target_label)+octet_length(result_url)+octet_length(error_code)) FROM agent_publications WHERE task_id=t.id),0))::bigint
 FROM writing_agent_tasks t WHERE t.id=task
$$;

-- Pending previews and durable receipts keep their article images available.
CREATE OR REPLACE VIEW agent_session_image_contents AS
 SELECT t.user_id,t.session_id,t.source->>'content' AS content FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,t.proposal->>'content' FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL AND t.proposal IS NOT NULL
 UNION ALL SELECT t.user_id,t.session_id,r.snapshot->'document'->>'content' FROM agent_document_reads r JOIN writing_agent_tasks t ON t.id=r.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,o.input->>'content' FROM agent_operations o JOIN writing_agent_tasks t ON t.id=o.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,o.before_state->'document'->>'content' FROM agent_operations o JOIN writing_agent_tasks t ON t.id=o.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,t.message FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,t.result FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT p.user_id,t.session_id,concat_ws(E'\n',p.snapshot->>'markdown',p.snapshot->>'cover') FROM agent_publications p JOIN writing_agent_tasks t ON t.id=p.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL;
