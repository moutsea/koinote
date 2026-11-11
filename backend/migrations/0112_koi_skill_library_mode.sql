-- Classify an account once, under its existing advisory lock, when Skills is
-- first used after rollout. NULL keeps accounts outside the rollout untouched.
ALTER TABLE agent_session_settings ADD COLUMN library_mode text
    CHECK (library_mode IN ('legacy','installed'));
