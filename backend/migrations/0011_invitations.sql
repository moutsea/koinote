-- 每个用户都有稳定的邀请码；奖励空间与会员基础配额分开累计。
ALTER TABLE users
    ADD COLUMN invitation_code varchar(16);
--> statement-breakpoint
ALTER TABLE users
    ADD COLUMN invited_by integer REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE users
    ADD COLUMN bonus_storage_bytes bigint NOT NULL DEFAULT 0 CHECK (bonus_storage_bytes >= 0);
--> statement-breakpoint
-- 现有用户用「id + auth_user_id 摘要」生成唯一邀请码。id 的完整 8 位十六进制
-- 保证这一批回填不会碰撞；新账号由应用层生成不可预测的随机码。
UPDATE users
SET invitation_code = upper(substr(md5(auth_user_id), 1, 8) || lpad(to_hex(id), 8, '0'))
WHERE invitation_code IS NULL;
--> statement-breakpoint
ALTER TABLE users
    ALTER COLUMN invitation_code SET NOT NULL;
--> statement-breakpoint
-- 给运维脚本和测试里未显式传邀请码的 INSERT 留安全默认值；正式注册仍由应用层
-- 使用 crypto/rand 生成邀请码。
ALTER TABLE users
    ALTER COLUMN invitation_code SET DEFAULT upper(substr(md5(random()::text || clock_timestamp()::text), 1, 16));
--> statement-breakpoint
CREATE UNIQUE INDEX users_invitation_code_idx ON users (invitation_code);
--> statement-breakpoint
CREATE INDEX users_invited_by_idx ON users (invited_by) WHERE invited_by IS NOT NULL;
--> statement-breakpoint
-- 奖励账本是幂等边界：同一个新用户最多对应一条邀请记录。
CREATE TABLE invitations (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    inviter_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    invited_user_id integer NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    reward_bytes    bigint NOT NULL CHECK (reward_bytes > 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (inviter_user_id <> invited_user_id)
);
--> statement-breakpoint
CREATE INDEX invitations_inviter_created_idx
    ON invitations (inviter_user_id, created_at DESC);
