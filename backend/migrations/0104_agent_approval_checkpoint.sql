-- Human approval pauses keep the same task, remote job, journal and reservation.
ALTER TABLE writing_agent_tasks ADD COLUMN approval_checkpoint text NOT NULL DEFAULT '';
