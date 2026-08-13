-- Disabling regular MCP history must not make full-document Agent writes irreversible.
-- At most one safety snapshot is maintained per document. It shares the configured
-- per-document and account-wide retention limits with regular versions.
ALTER TABLE document_versions
    ADD COLUMN IF NOT EXISTS safety_snapshot boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS document_versions_one_safety_snapshot_idx
    ON document_versions (document_id)
    WHERE safety_snapshot;
