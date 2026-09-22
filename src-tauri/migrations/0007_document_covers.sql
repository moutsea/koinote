ALTER TABLE offline_documents ADD COLUMN cover_mode TEXT NOT NULL DEFAULT 'default';
ALTER TABLE offline_documents ADD COLUMN cover_ratio TEXT NOT NULL DEFAULT '2.35:1';
ALTER TABLE offline_documents ADD COLUMN cover_image_source TEXT NOT NULL DEFAULT '';
ALTER TABLE offline_documents ADD COLUMN cover_prompt TEXT NOT NULL DEFAULT '';
