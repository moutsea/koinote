-- MCP personal access tokens. Authentication compares SHA-256(token) with token_hash.
-- A later migration adds an encrypted recovery copy for explicit owner-only reveal.
CREATE TABLE IF NOT EXISTS mcp_tokens (
    id           bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    token_id     text NOT NULL UNIQUE,
    user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         varchar(80) NOT NULL,
    token_hash   bytea NOT NULL UNIQUE,
    token_hint   varchar(24) NOT NULL,
    scope        varchar(16) NOT NULL CHECK (scope IN ('read', 'write')),
    expires_at   timestamptz,
    last_used_at timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_tokens_user_created_idx
    ON mcp_tokens (user_id, created_at DESC);
--> statement-breakpoint
-- Every real document mutation increments revision. last_web_version_at throttles
-- browser autosave snapshots without weakening compare-and-swap updates.
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
--> statement-breakpoint
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS last_web_version_at timestamptz;
--> statement-breakpoint
-- A row stores the complete document state before revision N was replaced.
-- Revision numbers may have gaps because browser snapshots are deliberately throttled.
CREATE TABLE IF NOT EXISTS document_versions (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    document_id     integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    revision        bigint NOT NULL CHECK (revision > 0),
    title           varchar(255) NOT NULL,
    theme           varchar(32) NOT NULL DEFAULT '',
    content         text NOT NULL,
    source          varchar(16) NOT NULL CHECK (source IN ('web', 'mcp', 'restore')),
    source_token_id bigint REFERENCES mcp_tokens(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, revision)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_versions_document_revision_idx
    ON document_versions (document_id, revision DESC);
--> statement-breakpoint
-- Operational audit only: never store document content or bearer-token bytes here.
CREATE TABLE IF NOT EXISTS mcp_audit_logs (
    id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_id    bigint REFERENCES mcp_tokens(id) ON DELETE SET NULL,
    tool_name   varchar(80) NOT NULL,
    document_id integer REFERENCES documents(id) ON DELETE SET NULL,
    result      varchar(16) NOT NULL CHECK (result IN ('success', 'error')),
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_audit_logs_user_created_idx
    ON mcp_audit_logs (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_audit_logs_created_idx
    ON mcp_audit_logs (created_at);
