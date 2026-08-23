ALTER TABLE users
    ADD COLUMN last_client varchar(16),
    ADD COLUMN last_client_at timestamptz,
    ADD CONSTRAINT users_last_client_check
        CHECK (last_client IS NULL OR last_client IN ('web', 'desktop'));
