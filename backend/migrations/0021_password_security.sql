-- 账户级会话版本。Cookie 中的版本必须与这里一致；改密或主动退出其他设备时递增，
-- 从而让已经签发、尚未自然过期的旧 Cookie 立即失效。
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS session_version bigint NOT NULL DEFAULT 1
    CHECK (session_version > 0);
--> statement-breakpoint
-- 密码找回码与注册验证码分表，避免两个 purpose 互相消费。这里只保存 HMAC。
CREATE TABLE IF NOT EXISTS password_reset_codes (
    email        varchar(255) PRIMARY KEY,
    code_hash    text NOT NULL,
    attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    expires_at   timestamptz NOT NULL,
    last_sent_at timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- 发送历史只保存邮箱 HMAC 与 IP HMAC；未知邮箱同样入账，以统一响应并执行双维度限流。
CREATE TABLE IF NOT EXISTS password_reset_sends (
    id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    email_hash text NOT NULL,
    ip_hash    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS password_reset_sends_email_created_idx
    ON password_reset_sends (email_hash, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS password_reset_sends_ip_created_idx
    ON password_reset_sends (ip_hash, created_at DESC);
