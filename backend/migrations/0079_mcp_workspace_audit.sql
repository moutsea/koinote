-- Keep the attempted target even after repository deletion, just like doc_id.
ALTER TABLE mcp_audit_logs
    ADD COLUMN workspace_id bigint,
    ADD COLUMN source_revision bigint,
    ADD COLUMN expected_revision bigint,
    ADD COLUMN resulting_revision bigint;
