CREATE INDEX IF NOT EXISTS agent_workspace_commit_files_blob_idx
    ON agent_workspace_commit_files (workspace_id, sha256);
CREATE INDEX IF NOT EXISTS agent_workspace_files_blob_idx
    ON agent_workspace_files (workspace_id, sha256);
CREATE INDEX IF NOT EXISTS agent_workspace_commits_account_oldest_idx
    ON agent_workspace_commits (created_at, workspace_id, revision);

CREATE OR REPLACE FUNCTION agent_workspace_storage_bytes(selected_user INTEGER)
RETURNS BIGINT LANGUAGE SQL STABLE AS $function$
    SELECT COALESCE((
        SELECT sum(octet_length(files.content))
        FROM agent_workspace_files files JOIN agent_workspaces workspace ON workspace.id = files.workspace_id
        WHERE workspace.user_id = selected_user AND workspace.deleted_at IS NULL
    ), 0) + COALESCE((
        SELECT sum(octet_length(blobs.content))
        FROM agent_workspace_blobs blobs JOIN agent_workspaces workspace ON workspace.id = blobs.workspace_id
        WHERE workspace.user_id = selected_user AND workspace.deleted_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM agent_workspace_files files
            WHERE files.workspace_id = blobs.workspace_id AND files.sha256 = blobs.sha256
        )
    ), 0);
$function$;

CREATE OR REPLACE FUNCTION prune_agent_workspace_account_history(selected_user INTEGER, max_bytes BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $function$
DECLARE
    used_bytes BIGINT;
    deleted_count INTEGER;
    workspace_id BIGINT;
BEGIN
    LOOP
        SELECT agent_workspace_storage_bytes(selected_user) INTO used_bytes;
        EXIT WHEN used_bytes <= max_bytes;

        WITH ranked AS (
            SELECT commits.workspace_id,
                   commits.revision,
                   row_number() OVER (ORDER BY commits.created_at, commits.workspace_id, commits.revision) AS history_number,
                   sum(GREATEST(commits.size_bytes, 0)) OVER (
                       ORDER BY commits.created_at, commits.workspace_id, commits.revision
                       ROWS UNBOUNDED PRECEDING
                   ) AS reclaimed_bytes
            FROM agent_workspace_commits commits
            JOIN agent_workspaces workspace ON workspace.id = commits.workspace_id
            WHERE workspace.user_id = selected_user
              AND workspace.deleted_at IS NULL
              AND commits.revision < workspace.revision
        ),
        victims AS (
            SELECT ranked.workspace_id, ranked.revision
            FROM ranked
            WHERE ranked.reclaimed_bytes <= GREATEST(used_bytes - max_bytes, 1)
               OR ranked.history_number = 1
        )
        DELETE FROM agent_workspace_commits commits
        USING victims
        WHERE commits.workspace_id = victims.workspace_id
          AND commits.revision = victims.revision;

        GET DIAGNOSTICS deleted_count = ROW_COUNT;
        EXIT WHEN deleted_count = 0;

        FOR workspace_id IN
            SELECT id FROM agent_workspaces
            WHERE user_id = selected_user AND deleted_at IS NULL
        LOOP
            PERFORM prune_agent_workspace_history(workspace_id, 100000000);
        END LOOP;
    END LOOP;
END;
$function$;

DROP TRIGGER IF EXISTS agent_workspace_history_retention ON agent_workspace_commits;
DROP FUNCTION IF EXISTS prune_agent_workspace_history_after_commit();

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
    SELECT 100000000 + COALESCE((SELECT bonus_bytes FROM agent_workspace_storage_quotas WHERE user_id = current_workspace.user_id), 0) INTO quota;
    PERFORM prune_agent_workspace_account_history(current_workspace.user_id, quota);
END;
$function$;

COMMENT ON FUNCTION agent_workspace_storage_bytes(INTEGER) IS
    'Logical Agent workspace bytes: current files plus retained historical blobs that are not current.';
