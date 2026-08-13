-- Keep the public document identifier even after the document itself is purged.
-- document_id remains useful while the row exists, but its ON DELETE SET NULL
-- foreign key must not erase the audit trail's only document reference.
ALTER TABLE mcp_audit_logs
    ADD COLUMN IF NOT EXISTS doc_id text;
--> statement-breakpoint
UPDATE mcp_audit_logs AS audit
SET doc_id = document.doc_id
FROM documents AS document
WHERE audit.document_id = document.id
  AND audit.doc_id IS NULL;
