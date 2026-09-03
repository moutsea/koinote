CREATE TABLE IF NOT EXISTS x_accounts (
    user_id                         integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    api_key                         text NOT NULL,
    api_secret_ciphertext           bytea NOT NULL,
    access_token_ciphertext         bytea NOT NULL,
    access_token_secret_ciphertext  bytea NOT NULL,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now()
);
