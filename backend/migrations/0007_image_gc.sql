-- 图片回收队列：删文档后把不再被引用的 R2 对象排队删掉。
--
-- 为什么用队列表而不是删文档时同步删：
--   1. 删 R2 要走一次网络到 Worker，会把删除响应从几十毫秒拖到几百毫秒
--   2. Worker 或网络挂掉时，同步删要么让删文档失败（更坏），要么静默漏掉这些对象
--      —— 漏掉是不可观测的，账单上才看得见
--   3. 重试需要状态，状态得有地方放
--
-- 没有引外部队列或 river 之类的作业框架：这里的作业量是「删文档的频率」，
-- 一张表加一个轮询 goroutine 足够，且不增加运维面。
CREATE TABLE IF NOT EXISTS pending_image_deletions (
    id          integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    -- R2 对象 key，形如 u/<authUserId>/<hex>.<ext>
    --
    -- UNIQUE：同一个 key 可能被多次入队（同一张图被两篇文档引用，两篇先后被删）。
    -- 入队时发生冲突会复用这行并重置失败状态，避免堆积重复行。
    object_key  text NOT NULL UNIQUE,
    -- 入队时归属的用户。ON DELETE CASCADE 会让「删用户」连带删掉队列行，
    -- 那时这些对象就没人回收了 —— 所以用 SET NULL 保住待删记录。
    -- 回收本身不需要用户存在，key 已经够了。
    user_id     integer REFERENCES users(id) ON DELETE SET NULL,
    attempts    integer NOT NULL DEFAULT 0,
    -- 最近一次失败的原因，只为排查。成功的行直接删掉，不留档
    last_error  text,
    -- 下次尝试的时间。失败后按指数退避推后，避免一个删不掉的 key 把每轮
    -- 循环都占满
    next_try_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- 取待办：按 next_try_at 排序拿到期的
CREATE INDEX IF NOT EXISTS pending_image_deletions_due_idx
    ON pending_image_deletions (next_try_at);
