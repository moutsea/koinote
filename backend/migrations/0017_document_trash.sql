-- Documents first enter a 30-day trash instead of being destroyed immediately.
-- Trashed rows intentionally keep counting toward storage quota and keep their image
-- references alive until the background cleanup permanently removes them.
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_user_active_updated_idx
    ON documents (user_id, updated_at DESC)
    WHERE trashed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_trash_cleanup_idx
    ON documents (trashed_at)
    WHERE trashed_at IS NOT NULL;
