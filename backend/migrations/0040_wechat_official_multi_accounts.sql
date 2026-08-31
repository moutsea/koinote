ALTER TABLE wechat_official_accounts
    ADD COLUMN account_id uuid;
--> statement-breakpoint
UPDATE wechat_official_accounts
SET account_id = gen_random_uuid()
WHERE account_id IS NULL;
--> statement-breakpoint
ALTER TABLE wechat_official_accounts
    ALTER COLUMN account_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE wechat_official_accounts
    DROP CONSTRAINT wechat_official_accounts_pkey;
--> statement-breakpoint
ALTER TABLE wechat_official_accounts
    ADD CONSTRAINT wechat_official_accounts_pkey PRIMARY KEY (account_id);
--> statement-breakpoint
ALTER TABLE wechat_official_accounts
    ADD COLUMN label varchar(80) NOT NULL DEFAULT '',
    ADD COLUMN is_default boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE wechat_official_accounts
SET is_default = true;
--> statement-breakpoint
CREATE INDEX wechat_official_accounts_user_idx
    ON wechat_official_accounts (user_id, created_at, account_id);
--> statement-breakpoint
CREATE UNIQUE INDEX wechat_official_accounts_one_default_idx
    ON wechat_official_accounts (user_id)
    WHERE is_default;
