-- Compatibility belongs to the public snapshot, never unpublished workspace edits.
-- NULL means not checked yet; the background indexer also checks existing entries.
ALTER TABLE agent_repository_publications ADD COLUMN koi_installable BOOLEAN;
ALTER TABLE agent_repository_publications ADD COLUMN koi_installability_checked_at TIMESTAMPTZ;
-- Capture the transaction that completed validation, rather than the claim time.
-- Directory cursors freeze visibility even when a check commits between pages.
ALTER TABLE agent_repository_publications ADD COLUMN koi_installability_xid XID8 DEFAULT pg_current_xact_id();
CREATE INDEX agent_repository_koi_directory_idx ON agent_repository_publications
    ((COALESCE(koi_installable,false)) DESC,published_at DESC,workspace_id DESC);
