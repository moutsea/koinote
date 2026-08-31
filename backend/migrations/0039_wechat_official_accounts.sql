CREATE TABLE IF NOT EXISTS wechat_official_accounts (
    user_id               integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    app_id                varchar(80) NOT NULL,
    app_secret_ciphertext bytea NOT NULL,
    app_secret_hint       varchar(32) NOT NULL,
    verified_at           timestamptz NOT NULL DEFAULT now(),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS wechat_official_accounts_app_id_idx
    ON wechat_official_accounts (app_id);
--> statement-breakpoint
COMMENT ON COLUMN wechat_official_accounts.app_secret_ciphertext IS
    'AES-GCM ciphertext; the key comes from WECHAT_CREDENTIAL_ENCRYPTION_KEY';
