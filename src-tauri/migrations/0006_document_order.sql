ALTER TABLE offline_documents
  ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE offline_documents
  ADD COLUMN order_dirty INTEGER NOT NULL DEFAULT 0 CHECK (order_dirty IN (0, 1));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS offline_documents_account_folder_order_idx
  ON offline_documents (account_id, folder_id, sort_order, doc_id);
