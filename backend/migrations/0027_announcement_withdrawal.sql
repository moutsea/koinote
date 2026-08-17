ALTER TABLE announcements
    ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS announcements_active_published_idx
    ON announcements (published_at, id)
    WHERE withdrawn_at IS NULL;
