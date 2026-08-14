PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS offline_documents (
  account_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  title TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  folder_id TEXT,
  local_revision INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  share_json TEXT,
  sync_state TEXT NOT NULL DEFAULT 'clean'
    CHECK (sync_state IN ('clean', 'create', 'update', 'trash', 'conflict')),
  folder_dirty INTEGER NOT NULL DEFAULT 0 CHECK (folder_dirty IN (0, 1)),
  change_seq INTEGER NOT NULL DEFAULT 0,
  remote_snapshot TEXT,
  last_error TEXT,
  PRIMARY KEY (account_id, doc_id)
);

CREATE INDEX IF NOT EXISTS offline_documents_account_updated_idx
  ON offline_documents (account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS offline_documents_pending_idx
  ON offline_documents (account_id, sync_state);

CREATE TABLE IF NOT EXISTS offline_folders (
  account_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_folder_id TEXT,
  sync_state TEXT NOT NULL DEFAULT 'clean'
    CHECK (sync_state IN ('clean', 'create', 'update', 'delete', 'conflict')),
  change_seq INTEGER NOT NULL DEFAULT 0,
  remote_snapshot TEXT,
  last_error TEXT,
  PRIMARY KEY (account_id, folder_id)
);

CREATE INDEX IF NOT EXISTS offline_folders_pending_idx
  ON offline_folders (account_id, sync_state);

CREATE TABLE IF NOT EXISTS offline_meta (
  account_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);
