-- Operator-managed cross-project sync grants. No public API can create a grant.
-- Bind to the exact publish token, destination and dedicated document folder;
-- rotating/deleting any of them requires explicit provisioning again.
CREATE TABLE mcp_wechat_sync_grants (
    token_id bigint NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES wechat_official_accounts(account_id) ON DELETE CASCADE,
    folder_id integer NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (token_id, account_id, folder_id)
);
