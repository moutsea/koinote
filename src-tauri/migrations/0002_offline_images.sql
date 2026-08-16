CREATE TABLE IF NOT EXISTS offline_images (
  account_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  base64_data TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  object_key TEXT,
  remote_url TEXT,
  created_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (account_id, image_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS offline_images_account_object_idx
  ON offline_images (account_id, object_key)
  WHERE object_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS offline_images_account_created_idx
  ON offline_images (account_id, created_at);
