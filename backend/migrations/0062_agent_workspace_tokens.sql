ALTER TABLE mcp_tokens
    DROP CONSTRAINT IF EXISTS mcp_tokens_scope_check;
--> statement-breakpoint
ALTER TABLE mcp_tokens
    ADD CONSTRAINT mcp_tokens_scope_check
    CHECK (scope IN ('read', 'write', 'publish', 'agent_read', 'agent_write'));
