-- Upgrade only queued conversations with a live reservation. Execution and
-- approval deadlines already in effect belong to their respective checkpoints.
WITH queued AS (
 UPDATE writing_agent_tasks t SET deadline=t.created_at+interval '24 hours'
 FROM credit_reservations r
 WHERE t.conversation_task AND NOT t.dispatch_started AND t.job_id='' AND t.remote_input IS NULL
 AND NOT t.cancel_requested AND t.status IN ('preparing','queued')
 AND r.reservation_id=t.reservation_id AND r.user_id=t.user_id AND r.status='active'
 AND r.expires_at>now() AND t.deadline>now()
 RETURNING t.reservation_id,t.deadline
)
UPDATE credit_reservations r SET expires_at=q.deadline+interval '10 minutes'
FROM queued q WHERE r.reservation_id=q.reservation_id;
