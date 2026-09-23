CREATE TABLE wechat_image_upload_cache (
    account_id   uuid NOT NULL REFERENCES wechat_official_accounts(account_id) ON DELETE CASCADE,
    app_id       varchar(80) NOT NULL,
    image_sha256 varchar(64) NOT NULL,
    image_url    text NOT NULL,
    uploaded_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, app_id, image_sha256)
);
--> statement-breakpoint
CREATE INDEX wechat_image_upload_cache_recent_idx
    ON wechat_image_upload_cache (account_id, uploaded_at DESC, app_id, image_sha256);
