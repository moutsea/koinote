CREATE TABLE IF NOT EXISTS feishu_accounts (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    app_id text NOT NULL,
    open_id text NOT NULL,
    name text NOT NULL,
    access_token_ciphertext bytea NOT NULL,
    refresh_token_ciphertext bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feishu_document_links (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id text NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    app_id text NOT NULL,
    open_id text NOT NULL,
    feishu_document_id text NOT NULL,
    source_revision bigint NOT NULL DEFAULT 0,
    synced_at timestamptz,
    PRIMARY KEY (user_id, document_id, app_id, open_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feishu_document_links_document_idx ON feishu_document_links(document_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feishu_oauth_pending (
    state text PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id text NOT NULL,
    code_verifier text NOT NULL,
    desktop_scheme text NOT NULL DEFAULT '' CHECK (desktop_scheme IN ('', 'koinote', 'koinote-local')),
    expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feishu_oauth_pending_expires_idx ON feishu_oauth_pending(expires_at);
