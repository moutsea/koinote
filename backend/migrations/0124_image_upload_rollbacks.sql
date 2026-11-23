-- Keep a short-lived rollback record after quota is released, so a delayed
-- image-record request cannot bill an object that has already been removed.
ALTER TABLE pending_image_deletions
    ADD COLUMN IF NOT EXISTS upload_aborted_at timestamptz;
