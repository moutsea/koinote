CREATE TABLE agent_repository_stars (
    workspace_id BIGINT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE agent_repository_clones (
    request_id UUID PRIMARY KEY,
    workspace_id BIGINT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    revision BIGINT NOT NULL CHECK (revision >= 0),
    method TEXT NOT NULL CHECK (method IN ('zip', 'home', 'agent')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_repository_clones_workspace_idx ON agent_repository_clones(workspace_id, created_at DESC);
CREATE INDEX agent_repository_publications_updated_idx ON agent_repository_publications(published_at DESC, workspace_id DESC);
ALTER TABLE agent_workspace_commits ADD COLUMN comment TEXT NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500);

-- Unreleased signature update: older callers still use the defaults.
DROP FUNCTION record_agent_workspace_commit(BIGINT, TEXT, BIGINT);
CREATE FUNCTION record_agent_workspace_commit(selected_id BIGINT, commit_action TEXT, restore_revision BIGINT DEFAULT NULL, commit_comment TEXT DEFAULT '')
RETURNS VOID LANGUAGE plpgsql AS $function$
DECLARE
    current_workspace agent_workspaces%ROWTYPE;
    quota BIGINT;
BEGIN
    SELECT * INTO STRICT current_workspace FROM agent_workspaces WHERE id = selected_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM agent_workspace_commits WHERE workspace_id = selected_id AND revision = current_workspace.revision) THEN
        RETURN;
    END IF;

    INSERT INTO agent_workspace_blobs (workspace_id, sha256, content)
    SELECT DISTINCT selected_id, encode(digest(content, 'sha256'), 'hex'), content
    FROM agent_workspace_files WHERE workspace_id = selected_id
    ON CONFLICT DO NOTHING;

    INSERT INTO agent_workspace_commits
        (workspace_id, revision, commit_id, parent_revision, action, restored_from, name, description, file_count, size_bytes, created_at, comment)
    SELECT selected_id, current_workspace.revision,
           encode(digest(convert_to(selected_id::text || ':' || current_workspace.revision::text, 'UTF8'), 'sha256'), 'hex'),
           (SELECT max(revision) FROM agent_workspace_commits WHERE workspace_id = selected_id),
           commit_action, restore_revision, current_workspace.name, current_workspace.description,
           count(*)::integer, COALESCE(sum(octet_length(content)), 0), current_workspace.updated_at, commit_comment
    FROM agent_workspace_files WHERE workspace_id = selected_id;

    INSERT INTO agent_workspace_commit_files (workspace_id, revision, path, mime_type, sha256, size_bytes)
    SELECT selected_id, current_workspace.revision, path, mime_type, encode(digest(content, 'sha256'), 'hex'), octet_length(content)
    FROM agent_workspace_files WHERE workspace_id = selected_id;

    PERFORM prune_agent_workspace_history(selected_id, 100000000);
    SELECT agent_workspace_quota_bytes(current_workspace.user_id) INTO quota;
    PERFORM prune_agent_workspace_quota_history(selected_id, quota);
END;
$function$;

-- Lifetime counters avoid scanning interaction history on every public read.
CREATE TABLE agent_repository_stats (
 workspace_id BIGINT PRIMARY KEY REFERENCES agent_workspaces(id) ON DELETE CASCADE,
 star_count BIGINT NOT NULL DEFAULT 0 CHECK(star_count >= 0),
 clone_count BIGINT NOT NULL DEFAULT 0 CHECK(clone_count >= 0)
);
CREATE FUNCTION update_agent_repository_stats() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
 IF TG_TABLE_NAME = 'agent_repository_stars' THEN
  IF TG_OP = 'DELETE' THEN
   UPDATE agent_repository_stats SET star_count=star_count-1 WHERE workspace_id=OLD.workspace_id;
  ELSE
   INSERT INTO agent_repository_stats(workspace_id,star_count) VALUES(NEW.workspace_id,1)
   ON CONFLICT(workspace_id) DO UPDATE SET star_count=agent_repository_stats.star_count+1;
  END IF;
 ELSE
  INSERT INTO agent_repository_stats(workspace_id,clone_count) VALUES(NEW.workspace_id,1)
  ON CONFLICT(workspace_id) DO UPDATE SET clone_count=agent_repository_stats.clone_count+1;
 END IF;
 RETURN NULL;
END;
$function$;
CREATE TRIGGER agent_repository_star_stats AFTER INSERT OR DELETE ON agent_repository_stars
 FOR EACH ROW EXECUTE FUNCTION update_agent_repository_stats();
CREATE TRIGGER agent_repository_clone_stats AFTER INSERT ON agent_repository_clones
 FOR EACH ROW EXECUTE FUNCTION update_agent_repository_stats();
CREATE INDEX agent_repository_clones_expiry_idx ON agent_repository_clones(created_at);
