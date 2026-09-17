CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE agent_workspace_blobs (
    workspace_id BIGINT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    content BYTEA NOT NULL,
    PRIMARY KEY (workspace_id, sha256)
);

CREATE TABLE agent_workspace_commits (
    workspace_id BIGINT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL,
    commit_id TEXT NOT NULL UNIQUE,
    parent_revision BIGINT,
    action TEXT NOT NULL,
    restored_from BIGINT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    file_count INTEGER NOT NULL,
    size_bytes BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, revision)
);

CREATE TABLE agent_workspace_commit_files (
    workspace_id BIGINT NOT NULL,
    revision BIGINT NOT NULL,
    path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, revision, path),
    FOREIGN KEY (workspace_id, revision) REFERENCES agent_workspace_commits(workspace_id, revision) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, sha256) REFERENCES agent_workspace_blobs(workspace_id, sha256) ON DELETE CASCADE
);

CREATE FUNCTION record_agent_workspace_commit(selected_id BIGINT, commit_action TEXT, restore_revision BIGINT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $function$
DECLARE
    current_workspace agent_workspaces%ROWTYPE;
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
        (workspace_id, revision, commit_id, parent_revision, action, restored_from, name, description, file_count, size_bytes, created_at)
    SELECT selected_id, current_workspace.revision,
           encode(digest(convert_to(selected_id::text || ':' || current_workspace.revision::text, 'UTF8'), 'sha256'), 'hex'),
           (SELECT max(revision) FROM agent_workspace_commits WHERE workspace_id = selected_id),
           commit_action, restore_revision, current_workspace.name, current_workspace.description,
           count(*)::integer, COALESCE(sum(octet_length(content)), 0), current_workspace.updated_at
    FROM agent_workspace_files WHERE workspace_id = selected_id;

    INSERT INTO agent_workspace_commit_files (workspace_id, revision, path, mime_type, sha256, size_bytes)
    SELECT selected_id, current_workspace.revision, path, mime_type, encode(digest(content, 'sha256'), 'hex'), octet_length(content)
    FROM agent_workspace_files WHERE workspace_id = selected_id;
END;
$function$;

SELECT record_agent_workspace_commit(id, 'baseline') FROM agent_workspaces WHERE deleted_at IS NULL;
