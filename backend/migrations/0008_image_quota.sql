-- 图片用量账本：每个 R2 对象一行，用于统计每用户占用并施加配额。
--
-- 为什么要建账本，而不是上传时给 users 加一个 used_bytes 计数器：
--   1. 计数器一旦漂了（漏减、重复加）没法自愈，只能靠人去 R2 里对账
--   2. 删文档的回收是异步的，减用量的时机和加用量不对称，计数器更容易漂
--   3. 有账本就能随时重算：SUM(bytes)，也能查"哪些对象占了这么多"
--
-- 代价是每次上传多一行插入。按这个产品的写入频率，不值得为省这一行去换一个会漂的计数器。
CREATE TABLE IF NOT EXISTS image_objects (
    -- R2 对象 key，形如 u/<authUserId>/<hex>.<ext>。
    -- 直接做主键：它本来就唯一，且 Worker 报账时只有这个标识
    object_key  text PRIMARY KEY,
    -- ON DELETE CASCADE：用户删号时账本一起清掉。
    -- 与 pending_image_deletions 的 SET NULL 不同 —— 那张表要在用户没了之后
    -- 继续把对象删掉，而这张表只是用量统计，用户不存在就没有意义了
    user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bytes       bigint NOT NULL CHECK (bytes >= 0),
    created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- 按用户求和是最热的查询（每次上传校验配额 + 控制台展示）
CREATE INDEX IF NOT EXISTS image_objects_user_idx
    ON image_objects (user_id);
