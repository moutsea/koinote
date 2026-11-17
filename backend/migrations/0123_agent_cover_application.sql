-- Keep previous covers available for preview and undo until the session is deleted.
CREATE OR REPLACE VIEW agent_session_image_contents AS
 SELECT t.user_id,t.session_id,t.source->>'content' AS content FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,t.proposal->>'content' FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL AND t.proposal IS NOT NULL
 UNION ALL SELECT t.user_id,t.session_id,concat_ws(E'\n',r.snapshot->'document'->>'content',r.snapshot->'document'->>'coverImageSource') FROM agent_document_reads r JOIN writing_agent_tasks t ON t.id=r.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,o.input->>'content' FROM agent_operations o JOIN writing_agent_tasks t ON t.id=o.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,concat_ws(E'\n',o.before_state->'document'->>'content',o.before_state->'document'->>'coverImageSource') FROM agent_operations o JOIN writing_agent_tasks t ON t.id=o.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,t.message FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,t.result FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT p.user_id,t.session_id,concat_ws(E'\n',p.snapshot->>'markdown',p.snapshot->>'cover') FROM agent_publications p JOIN writing_agent_tasks t ON t.id=p.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL;
