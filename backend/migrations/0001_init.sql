-- 用户表：MVP 登录闭环所需的最小字段集
CREATE TABLE IF NOT EXISTS users (
    id            integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    auth_user_id  text NOT NULL UNIQUE,
    email         varchar(255) NOT NULL,
    username      varchar(255) UNIQUE,
    password_hash text,
    nickname      varchar(255),
    avatar_url    text,
    is_verified   boolean NOT NULL DEFAULT false,
    is_admin      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- 邮箱大小写不敏感唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username)) WHERE username IS NOT NULL;
