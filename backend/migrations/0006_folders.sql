-- 文件夹：侧栏从扁平列表变成可嵌套的文件树。
--
-- 为什么单独一张表而不是给 documents 加 parent_id：文件夹没有正文、不能分享、
-- 没有排版主题。混在一张表里的话这些列对文件夹行永远是空的，而「分享一个文件夹」
-- 「导出一个文件夹」这类请求要靠运行时判断挡掉 —— 类型上分开更省事。
--
-- folder_id 自引用，深度不限。防环由服务端的递归 CTE 负责（见 folders.go）：
-- 数据库层面表达不了「不能移进自己的子孙」这条约束。
CREATE TABLE IF NOT EXISTS folders (
    id         integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    folder_id  text NOT NULL UNIQUE,
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 父文件夹。NULL 表示在根下。
    --
    -- ON DELETE SET NULL 而非 CASCADE：删一个文件夹不该连带删掉整棵子树。
    -- 服务端会先把子项提到父级再删，这里的 SET NULL 只是兜底 —— 万一有路径绕过了
    -- 那段逻辑，结果是子文件夹落到根下（还能找到），而不是静默消失。
    parent_id  integer REFERENCES folders(id) ON DELETE SET NULL,
    name       varchar(120) NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- 取某人的整棵树是一次全量查询，这条索引服务它
CREATE INDEX IF NOT EXISTS folders_user_parent_idx
    ON folders (user_id, parent_id);
--> statement-breakpoint
-- 文档所属文件夹。NULL = 根下，与 folders.parent_id 同一套语义。
-- SET NULL 同理：删文件夹时文档退回根下，不跟着消失。
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS folder_id integer REFERENCES folders(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_user_folder_idx
    ON documents (user_id, folder_id);
