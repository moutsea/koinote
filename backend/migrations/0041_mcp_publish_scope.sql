-- Publish-scoped MCP tokens may create drafts in external publishing platforms.
-- They retain read access but cannot mutate Koinote documents.
ALTER TABLE mcp_tokens
    DROP CONSTRAINT IF EXISTS mcp_tokens_scope_check;
--> statement-breakpoint
ALTER TABLE mcp_tokens
    ADD CONSTRAINT mcp_tokens_scope_check
    CHECK (scope IN ('read', 'write', 'publish'));
