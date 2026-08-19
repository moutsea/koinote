-- 自动整理文件夹需要与用户手动创建、导入的文件夹区分。
-- NULL 表示用户目录；smart/activity 表示对应整理策略创建的目录。
ALTER TABLE folders
    ADD COLUMN organizer_kind varchar(16)
    CHECK (organizer_kind IS NULL OR organizer_kind IN ('smart', 'activity'));
