-- 超出账户配额时只裁剪本次写入的仓库历史，绝不静默删除其他仓库的提交；
-- 裁完仍超额则由应用层返回配额不足。按 blob 的最后引用版本精确计算可释放字节，一次完成，不再循环。
DROP INDEX IF EXISTS agent_workspace_commits_account_oldest_idx;

CREATE OR REPLACE FUNCTION prune_agent_workspace_quota_history(selected_id BIGINT, max_bytes BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $function$
DECLARE
    owner_id INTEGER;
    excess_bytes BIGINT;
    newest_revision BIGINT;
    cutoff_revision BIGINT;
BEGIN
    SELECT user_id INTO owner_id FROM agent_workspaces WHERE id = selected_id;
    IF owner_id IS NULL THEN
        RETURN;
    END IF;
    excess_bytes := agent_workspace_storage_bytes(owner_id) - max_bytes;
    IF excess_bytes <= 0 THEN
        RETURN;
    END IF;
    SELECT max(revision) INTO newest_revision FROM agent_workspace_commits WHERE workspace_id = selected_id;
    IF newest_revision IS NULL THEN
        RETURN;
    END IF;

    -- 删除 revision <= R 的全部提交后，最后引用版本 <= R 的非当前 blob 都会被回收。
    WITH blob_last_reference AS (
        SELECT refs.sha256, refs.last_revision, octet_length(blobs.content)::BIGINT AS bytes
        FROM (
            SELECT sha256, max(revision) AS last_revision
            FROM agent_workspace_commit_files
            WHERE workspace_id = selected_id
            GROUP BY sha256
        ) refs
        JOIN agent_workspace_blobs blobs ON blobs.workspace_id = selected_id AND blobs.sha256 = refs.sha256
        WHERE NOT EXISTS (
            SELECT 1 FROM agent_workspace_files current_files
            WHERE current_files.workspace_id = selected_id AND current_files.sha256 = refs.sha256
        )
    ),
    freed_by_revision AS (
        SELECT last_revision AS revision, sum(bytes) AS freed_bytes
        FROM blob_last_reference
        GROUP BY last_revision
    ),
    candidates AS (
        SELECT commits.revision,
               COALESCE(sum(freed.freed_bytes) OVER (ORDER BY commits.revision ROWS UNBOUNDED PRECEDING), 0) AS reclaimed_bytes
        FROM agent_workspace_commits commits
        LEFT JOIN freed_by_revision freed ON freed.revision = commits.revision
        WHERE commits.workspace_id = selected_id AND commits.revision < newest_revision
    )
    SELECT COALESCE(
        (SELECT min(revision) FROM candidates WHERE reclaimed_bytes >= excess_bytes),
        (SELECT max(revision) FROM candidates)
    ) INTO cutoff_revision;

    IF cutoff_revision IS NULL THEN
        RETURN;
    END IF;
    DELETE FROM agent_workspace_commits
    WHERE workspace_id = selected_id AND revision <= cutoff_revision;
    -- 复用单仓库保留规则顺带回收不再被引用的 blob。
    PERFORM prune_agent_workspace_history(selected_id, 100000000);
END;
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
    SELECT 100000000 + COALESCE((SELECT bonus_bytes FROM agent_workspace_storage_quotas WHERE user_id = current_workspace.user_id), 0) INTO quota;
    PERFORM prune_agent_workspace_quota_history(selected_id, quota);
END;
$function$;

DROP FUNCTION IF EXISTS prune_agent_workspace_account_history(INTEGER, BIGINT);
