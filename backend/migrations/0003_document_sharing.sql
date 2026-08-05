-- 文档分享：三档权限（link / public / password）
--
-- share_token 与 doc_id 分开：撤销分享后重新开启会换新 token，
-- 老链接永久失效。若复用 doc_id 做分享标识，撤销就等于无效。
ALTER TABLE documents ADD COLUMN IF NOT EXISTS share_token text;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS share_access varchar(16);
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS share_password_hash text;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS shared_at timestamptz;
--> statement-breakpoint
-- 部分唯一索引：只约束已分享的文档。
-- 未分享的行 share_token 为 NULL，不进索引，也不会互相冲突。
CREATE UNIQUE INDEX IF NOT EXISTS documents_share_token_idx
    ON documents (share_token) WHERE share_token IS NOT NULL;
