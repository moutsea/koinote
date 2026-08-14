-- 分享阅读次数只做累计值，不记录读者身份、IP 或 User-Agent。
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS share_view_count bigint NOT NULL DEFAULT 0
    CHECK (share_view_count >= 0);
--> statement-breakpoint
-- 产品漏斗只保存“某用户首次完成某动作”的时间，不保存文档标题、正文、搜索词、
-- 文件名或支付页面输入。唯一约束让重复请求天然幂等。
CREATE TABLE IF NOT EXISTS product_milestones (
    id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_name  varchar(32) NOT NULL CHECK (event_name IN (
        'registered',
        'first_document',
        'first_upload',
        'first_export',
        'mcp_connected',
        'checkout_started',
        'checkout_completed'
    )),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, event_name)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_milestones_event_time_idx
    ON product_milestones (event_name, occurred_at);
--> statement-breakpoint
-- 留存只需要知道某个账号哪一天活跃过。一天一行，不记录访问了哪个页面或文档。
CREATE TABLE IF NOT EXISTS user_daily_activity (
    user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_date date NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, activity_date)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_daily_activity_date_idx
    ON user_daily_activity (activity_date);
--> statement-breakpoint
-- 留存只能从本迁移上线后开始准确观测；管理后台会展示这个起点，避免把历史用户
-- 没有日活记录误读成“全部流失”。
CREATE TABLE IF NOT EXISTS product_analytics_meta (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    tracking_started_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO product_analytics_meta (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;
--> statement-breakpoint
-- 能从业务真值还原的历史里程碑在迁移时补齐；首次导出无法可靠回溯，故从上线后计。
INSERT INTO product_milestones (user_id, event_name, occurred_at)
SELECT id, 'registered', created_at FROM users
ON CONFLICT (user_id, event_name) DO NOTHING;
--> statement-breakpoint
INSERT INTO product_milestones (user_id, event_name, occurred_at)
SELECT user_id, 'first_document', MIN(created_at) FROM documents GROUP BY user_id
ON CONFLICT (user_id, event_name) DO NOTHING;
--> statement-breakpoint
INSERT INTO product_milestones (user_id, event_name, occurred_at)
SELECT user_id, 'first_upload', MIN(created_at)
FROM image_objects WHERE purpose = 'persistent' GROUP BY user_id
ON CONFLICT (user_id, event_name) DO NOTHING;
--> statement-breakpoint
INSERT INTO product_milestones (user_id, event_name, occurred_at)
SELECT user_id, 'mcp_connected', MIN(created_at)
FROM mcp_audit_logs WHERE result = 'success' GROUP BY user_id
ON CONFLICT (user_id, event_name) DO NOTHING;
--> statement-breakpoint
INSERT INTO product_milestones (user_id, event_name, occurred_at)
SELECT user_id, 'checkout_started', MIN(created_at) FROM stripe_payments GROUP BY user_id
ON CONFLICT (user_id, event_name) DO NOTHING;
--> statement-breakpoint
INSERT INTO product_milestones (user_id, event_name, occurred_at)
SELECT user_id, 'checkout_completed', MIN(created_at) FROM stripe_payments GROUP BY user_id
ON CONFLICT (user_id, event_name) DO NOTHING;
