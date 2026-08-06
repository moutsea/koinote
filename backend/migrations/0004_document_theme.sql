-- 文档主题：微信排版主题从「导出时选一次」变成文档自身的属性
--
-- 为什么挂在文档上而不是做成用户偏好：排版属于文章。同一个人写课程讲义和写
-- 活动公告会选不同主题，存成全局偏好的话每切一篇文档都要重选一次。
--
-- 空串表示「不套主题」，编辑区退回应用自身的默认排版 —— 不是每个人都想整天
-- 盯着强风格的主题写稿。已有文档回填 'minimal'（ADD COLUMN 带 DEFAULT 会补齐
-- 存量行），与新建文档的默认一致。
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS theme varchar(32) NOT NULL DEFAULT 'minimal';
