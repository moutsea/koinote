-- 邮箱注册验证码。只保存 HMAC，不保存明文验证码；邮箱是待验证对象，因此作为主键。
CREATE TABLE IF NOT EXISTS email_verification_codes (
    email        varchar(255) PRIMARY KEY,
    code_hash    text NOT NULL,
    attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    expires_at   timestamptz NOT NULL,
    last_sent_at timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- 单独记录发送历史，才能在验证码被覆盖后继续执行邮箱/IP 小时级限流。
-- IP 只保存 HMAC，避免把访问来源明文留在数据库里。
CREATE TABLE IF NOT EXISTS email_verification_sends (
    id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    email      varchar(255) NOT NULL,
    ip_hash    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_verification_sends_email_created_idx
    ON email_verification_sends (email, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_verification_sends_ip_created_idx
    ON email_verification_sends (ip_hash, created_at DESC);
