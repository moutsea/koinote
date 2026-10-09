-- Scan results share the lifetime of the immutable, content-addressed blob.
-- NULL means unscanned. A policy digest mismatch requires another scan.
ALTER TABLE agent_workspace_blobs
    ADD COLUMN content_scan_policy TEXT,
    ADD COLUMN content_scan_sensitive BOOLEAN,
    ADD CONSTRAINT agent_workspace_blob_scan_complete CHECK (
        (content_scan_policy IS NULL) = (content_scan_sensitive IS NULL)
        AND (content_scan_policy IS NULL OR content_scan_policy ~ '^[0-9a-f]{64}$')
    );
