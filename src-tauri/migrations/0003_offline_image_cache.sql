ALTER TABLE offline_images
  ADD COLUMN is_local_origin INTEGER NOT NULL DEFAULT 0
  CHECK (is_local_origin IN (0, 1));

UPDATE offline_images
SET is_local_origin = 1
WHERE object_key IS NULL AND remote_url IS NULL;

CREATE INDEX IF NOT EXISTS offline_images_remote_cache_idx
  ON offline_images (account_id, is_local_origin);
