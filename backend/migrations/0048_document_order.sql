-- User-controlled document order within each folder (including the root).
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS sort_order bigint NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Preserve the existing sidebar order for documents already in the database.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id, folder_id
               ORDER BY updated_at DESC, id DESC
           ) - 1 AS next_order
    FROM documents
    WHERE trashed_at IS NULL
)
UPDATE documents AS d
SET sort_order = ranked.next_order
FROM ranked
WHERE d.id = ranked.id;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS documents_user_folder_order_idx
    ON documents (user_id, folder_id, sort_order, id);
