-- 公众号公式图是七天后回收的临时导出产物，不应挤占用户的正文云存储配额。
-- purpose 仍保留在账本中，让 GC 删除 R2 后可以统一清账，也让后台能看到真实物理用量。
ALTER TABLE image_objects
    ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'persistent';
--> statement-breakpoint
ALTER TABLE image_objects
    DROP CONSTRAINT IF EXISTS image_objects_purpose_check;
--> statement-breakpoint
ALTER TABLE image_objects
    ADD CONSTRAINT image_objects_purpose_check
    CHECK (purpose IN ('persistent', 'wechat-export'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS image_objects_user_purpose_idx
    ON image_objects (user_id, purpose);
