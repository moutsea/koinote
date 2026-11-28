-- 仅新账号采集首触，历史用户通过 LEFT JOIN / COALESCE 表达 unknown。
CREATE TABLE user_registration_attribution (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    utm_source varchar(128) NOT NULL DEFAULT '',
    utm_medium varchar(128) NOT NULL DEFAULT '',
    utm_campaign varchar(128) NOT NULL DEFAULT '',
    referrer_host varchar(253) NOT NULL DEFAULT '',
    landing_path varchar(256) NOT NULL,
    first_source varchar(253) NOT NULL,
    captured_at timestamptz NOT NULL,
    share_source_key varchar(64) CHECK (share_source_key ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE product_milestones
    DROP CONSTRAINT product_milestones_event_name_check,
    ADD CONSTRAINT product_milestones_event_name_check CHECK (event_name IN (
        'registered', 'first_document', 'first_upload', 'first_export',
        'mcp_connected', 'checkout_started', 'checkout_completed', 'share_signup'
    )),
    ADD COLUMN share_source_key varchar(64),
    ADD CONSTRAINT product_milestones_share_source_check CHECK (
        (event_name = 'share_signup' AND share_source_key IS NOT NULL
            AND share_source_key ~ '^[a-f0-9]{64}$')
        OR (event_name <> 'share_signup' AND share_source_key IS NULL)
    );
--> statement-breakpoint
-- 首次成功运行新注册采集链时写入，避免把迁移先行时间当作采集启用时间。
ALTER TABLE product_analytics_meta
    ADD COLUMN attribution_started_at timestamptz,
    ADD COLUMN share_signup_started_at timestamptz;
