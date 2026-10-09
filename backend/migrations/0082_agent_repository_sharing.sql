-- An explicitly published snapshot; private workspace edits never change it.
CREATE TABLE agent_repository_publications (
    workspace_id BIGINT PRIMARY KEY REFERENCES agent_workspaces(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL CHECK (revision >= 0),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    license TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE agent_repository_publication_files (
    workspace_id BIGINT NOT NULL REFERENCES agent_repository_publications(workspace_id) ON DELETE CASCADE,
    file_id BIGINT NOT NULL,
    path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, path),
    UNIQUE (workspace_id, file_id),
    FOREIGN KEY (workspace_id, sha256) REFERENCES agent_workspace_blobs(workspace_id, sha256) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX agent_repository_publication_blobs_idx ON agent_repository_publication_files(workspace_id, sha256);
CREATE TABLE agent_repository_forks (
    workspace_id BIGINT PRIMARY KEY REFERENCES agent_workspaces(id) ON DELETE CASCADE,
    source_workspace_id BIGINT REFERENCES agent_workspaces(id) ON DELETE SET NULL,
    source_revision BIGINT NOT NULL,
    source_name TEXT NOT NULL,
    source_license TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    UNIQUE (user_id, request_id)
);

CREATE INDEX agent_repository_forks_source_idx ON agent_repository_forks(source_workspace_id);

-- Public references share the existing quota-accounted blobs, independent of history retention.
CREATE OR REPLACE FUNCTION prune_agent_workspace_history(selected_id BIGINT, max_bytes BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $function$
BEGIN
    -- Keep the newest revision even when one snapshot is larger than the history budget.
    WITH ranked AS (
        SELECT revision,
               max(revision) OVER () AS newest_revision,
               row_number() OVER (ORDER BY revision DESC) AS history_number,
               sum(size_bytes) OVER (ORDER BY revision DESC ROWS UNBOUNDED PRECEDING) AS retained_bytes
        FROM agent_workspace_commits
        WHERE workspace_id = selected_id
    )
    DELETE FROM agent_workspace_commits commits
    USING ranked
    WHERE commits.workspace_id = selected_id
      AND commits.revision = ranked.revision
      AND (ranked.history_number > 100 OR ranked.retained_bytes > max_bytes)
      AND ranked.revision <> ranked.newest_revision;

    -- commit_files cascades with the commit; blobs need explicit garbage collection.
    DELETE FROM agent_workspace_blobs blobs
    WHERE blobs.workspace_id = selected_id
      AND NOT EXISTS (
          SELECT 1 FROM agent_workspace_commit_files files
          WHERE files.workspace_id = blobs.workspace_id
            AND files.sha256 = blobs.sha256
      )
      AND NOT EXISTS (
          SELECT 1 FROM agent_repository_publication_files public_files
          WHERE public_files.workspace_id = blobs.workspace_id AND public_files.sha256 = blobs.sha256
      )
      AND NOT EXISTS (
          SELECT 1 FROM agent_workspace_files current_files
          WHERE current_files.workspace_id = blobs.workspace_id
            AND current_files.sha256 = blobs.sha256
      );
END;
$function$;

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
            SELECT 1 FROM agent_repository_publication_files public_files
            WHERE public_files.workspace_id = selected_id AND public_files.sha256 = refs.sha256
        ) AND NOT EXISTS (
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
    -- Do not discard history when even the entire eligible prefix cannot fit.
    SELECT min(revision) INTO cutoff_revision FROM candidates WHERE reclaimed_bytes >= excess_bytes;

    IF cutoff_revision IS NULL THEN
        RETURN;
    END IF;
    DELETE FROM agent_workspace_commits
    WHERE workspace_id = selected_id AND revision <= cutoff_revision;
    -- 复用单仓库保留规则顺带回收不再被引用的 blob。
    PERFORM prune_agent_workspace_history(selected_id, 100000000);
END;
$function$;
