-- Existing temporary grants lack a session binding and become invalid.
ALTER TABLE config_sync_grants ADD COLUMN session_version bigint NOT NULL DEFAULT -1;
ALTER TABLE config_sync_grants ADD COLUMN desktop_family_id text;
