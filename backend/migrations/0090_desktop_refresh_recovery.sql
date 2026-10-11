-- A persisted client retry secret binds recovery to one refresh attempt. Only
-- hashes are stored; the successor refresh token is derived from both secrets.
ALTER TABLE desktop_refresh_tokens
    ADD COLUMN refresh_request_hash bytea,
    ADD COLUMN recovery_refresh_hash bytea,
    ADD CONSTRAINT desktop_refresh_recovery_hashes CHECK (
        (refresh_request_hash IS NULL AND recovery_refresh_hash IS NULL) OR
        (refresh_request_hash IS NOT NULL AND recovery_refresh_hash IS NOT NULL AND
         octet_length(refresh_request_hash) = 32 AND octet_length(recovery_refresh_hash) = 32)
    );
