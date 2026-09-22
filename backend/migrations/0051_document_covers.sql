ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS cover_mode text NOT NULL DEFAULT 'default',
    ADD COLUMN IF NOT EXISTS cover_ratio text NOT NULL DEFAULT '2.35:1',
    ADD COLUMN IF NOT EXISTS cover_image_source text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS cover_prompt text NOT NULL DEFAULT '';
