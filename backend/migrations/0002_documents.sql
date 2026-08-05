-- 文档表：编辑器的持久化载体
--
-- doc_id 与自增 id 分开的原因（沿用 users.auth_user_id 的模式）：
-- 对外暴露的是随机 ID 而非自增整数，即使某条查询漏写归属过滤，
-- 攻击者也无法靠枚举遍历他人文档。授权的实质仍是每条 SQL 都带 user_id。
CREATE TABLE IF NOT EXISTS documents (
    id         integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    doc_id     text NOT NULL UNIQUE,
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      varchar(255) NOT NULL DEFAULT '',
    content    text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- 侧边栏按「最近编辑」排序取列表，这条索引直接服务该查询
CREATE INDEX IF NOT EXISTS documents_user_updated_idx
    ON documents (user_id, updated_at DESC);
