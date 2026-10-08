-- Keep the included 100 MB and existing grants; only self-service expansion reserves personal storage.
ALTER TABLE agent_workspace_storage_quotas
    ADD COLUMN allocated_bytes BIGINT NOT NULL DEFAULT 0 CHECK (allocated_bytes >= 0);

CREATE FUNCTION agent_workspace_quota_bytes(selected_user INTEGER)
RETURNS BIGINT LANGUAGE SQL STABLE AS $function$
    SELECT 100000000 + COALESCE((
        SELECT bonus_bytes + allocated_bytes FROM agent_workspace_storage_quotas
        WHERE user_id = selected_user
    ), 0);
$function$;

CREATE OR REPLACE FUNCTION record_agent_workspace_commit(selected_id BIGINT, commit_action TEXT, restore_revision BIGINT DEFAULT NULL)
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

    PERFORM prune_agent_workspace_history(selected_id, 100000000);
    SELECT agent_workspace_quota_bytes(current_workspace.user_id) INTO quota;
    PERFORM prune_agent_workspace_quota_history(selected_id, quota);
END;
$function$;
