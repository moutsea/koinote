-- 编辑器标签页：打开了哪几篇、当前是哪一篇。跟账号走，换设备能恢复同一组标签。
--
-- 为什么不做成一行 JSON：doc_id 上的外键 + ON DELETE CASCADE 让「删文档自动清
-- 标签」由数据库负责。存 JSON 的话删除逻辑里得另写一遍摘除，漏写就留下指向
-- 不存在文档的僵尸标签。
--
-- position 决定标签栏顺序。它不做唯一约束：整组覆盖式写入（事务内先删后插）
-- 期间会短暂出现重复值，加了约束反而要求写入方按序处理。
CREATE TABLE IF NOT EXISTS editor_tabs (
    user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_id    text NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    position  integer NOT NULL,
    is_active boolean NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, doc_id)
);
--> statement-breakpoint
-- 一个用户最多一个活动标签。部分索引而非 CHECK：约束的是「同一 user 下至多
-- 一行 is_active」，只有唯一索引能表达。
CREATE UNIQUE INDEX IF NOT EXISTS editor_tabs_one_active
    ON editor_tabs (user_id) WHERE is_active;
--> statement-breakpoint
-- 取标签组时按 user_id 过滤并按 position 排序，这条索引直接服务该查询
CREATE INDEX IF NOT EXISTS editor_tabs_user_position_idx
    ON editor_tabs (user_id, position);
