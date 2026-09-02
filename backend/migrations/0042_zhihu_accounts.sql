CREATE TABLE IF NOT EXISTS zhihu_accounts (
    user_id                 integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    app_key                 varchar(160) NOT NULL,
    app_secret_ciphertext   bytea NOT NULL,
    app_secret_hint         varchar(32) NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS zhihu_accounts_app_key_idx
    ON zhihu_accounts (app_key);
--> statement-breakpoint
COMMENT ON COLUMN zhihu_accounts.app_secret_ciphertext IS
    'AES-GCM ciphertext; the key comes from ZHIHU_CREDENTIAL_ENCRYPTION_KEY';
