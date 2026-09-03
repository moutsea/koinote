CREATE TABLE IF NOT EXISTS x_oauth2_accounts (
    user_id                         integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token_ciphertext         bytea NOT NULL,
    refresh_token_ciphertext         bytea NOT NULL,
    expires_at                       timestamptz NOT NULL,
    x_user_id                       text NOT NULL,
    x_username                      text NOT NULL,
    scope                            text NOT NULL DEFAULT '',
    created_at                       timestamptz NOT NULL DEFAULT now(),
    updated_at                       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS x_oauth2_pending (
    state                            text PRIMARY KEY,
    user_id                         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_verifier                   text NOT NULL,
    redirect_to                     text NOT NULL,
    desktop                         boolean NOT NULL DEFAULT false,
    desktop_scheme                  text NOT NULL DEFAULT '' CHECK (desktop_scheme IN ('', 'koinote', 'koinote-local')),
    expires_at                      timestamptz NOT NULL,
    created_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS x_oauth2_pending_expires_idx
    ON x_oauth2_pending (expires_at);
