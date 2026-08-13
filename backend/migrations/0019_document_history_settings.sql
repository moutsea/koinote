-- Account-level version-history policy. Lifetime members can tune it from the
-- dashboard or through a write-scoped MCP token. Existing behavior remains the
-- default: enabled, 20 versions per document, and MCP writes retained.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS document_history_enabled boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS document_history_limit integer NOT NULL DEFAULT 20
        CHECK (document_history_limit BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS mcp_history_enabled boolean NOT NULL DEFAULT true;
