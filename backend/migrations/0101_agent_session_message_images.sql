-- Images linked in chat messages/results are retained just like images in
-- proposal snapshots. Deleting a chat releases only its final references.
CREATE OR REPLACE VIEW agent_session_image_contents AS
 SELECT t.user_id,t.session_id,t.source->>'content' AS content FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,t.proposal->>'content' FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL AND t.proposal IS NOT NULL
 UNION ALL SELECT t.user_id,t.session_id,r.snapshot->'document'->>'content' FROM agent_document_reads r JOIN writing_agent_tasks t ON t.id=r.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,o.input->>'content' FROM agent_operations o JOIN writing_agent_tasks t ON t.id=o.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,o.before_state->'document'->>'content' FROM agent_operations o JOIN writing_agent_tasks t ON t.id=o.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,t.message FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL
 UNION ALL SELECT t.user_id,t.session_id,t.result FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.deleted_at IS NULL;
