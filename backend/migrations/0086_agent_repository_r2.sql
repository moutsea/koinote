-- Repository bytes move to a private R2 bucket. PostgreSQL keeps indexes,
-- logical sizes and references; legacy bytes remain readable until verified migration.
CREATE TABLE agent_repository_objects (
    object_key TEXT PRIMARY KEY CHECK (object_key ~ '^objects/[0-9a-f]{32}/[0-9a-f]{64}$'),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 0 AND 5242880),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    committed BOOLEAN NOT NULL DEFAULT false,
    delete_after TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day',
    UNIQUE (object_key, sha256, size_bytes)
);
CREATE INDEX agent_repository_objects_expiry_idx ON agent_repository_objects(delete_after);
ALTER TABLE agent_workspace_blobs
    ALTER COLUMN content DROP NOT NULL,
    ADD COLUMN r2_object_key TEXT,
    ADD COLUMN size_bytes BIGINT NOT NULL DEFAULT 0;
UPDATE agent_workspace_blobs SET size_bytes=octet_length(content);
ALTER TABLE agent_workspace_blobs
    ADD CONSTRAINT agent_workspace_blob_storage CHECK (
        (content IS NOT NULL AND r2_object_key IS NULL) OR
        (content IS NULL AND r2_object_key IS NOT NULL)
    ),
    ADD CONSTRAINT agent_workspace_blob_object_fk FOREIGN KEY (r2_object_key, sha256, size_bytes)
        REFERENCES agent_repository_objects(object_key, sha256, size_bytes);
CREATE INDEX agent_workspace_blobs_object_idx ON agent_workspace_blobs(r2_object_key) WHERE r2_object_key IS NOT NULL;
CREATE INDEX agent_workspace_blobs_legacy_idx ON agent_workspace_blobs(workspace_id,sha256) WHERE content IS NOT NULL;
ALTER TABLE agent_workspace_files ALTER COLUMN content DROP NOT NULL;

-- Keep committed bytes beyond the existing database backup retention (400 days).
-- A database backup can then restore its object references without missing files.
CREATE FUNCTION retain_agent_repository_object() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.r2_object_key IS NOT NULL THEN
        UPDATE agent_repository_objects SET committed=true,
            delete_after=GREATEST(delete_after, now()+interval '401 days') WHERE object_key=OLD.r2_object_key;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.r2_object_key IS NOT NULL THEN
        UPDATE agent_repository_objects SET committed=true,
            delete_after=GREATEST(delete_after, now()+interval '401 days') WHERE object_key=NEW.r2_object_key;
    END IF;
    RETURN NULL;
END;
$function$;
CREATE TRIGGER retain_agent_repository_object AFTER INSERT OR DELETE OR UPDATE OF r2_object_key ON agent_workspace_blobs
    FOR EACH ROW EXECUTE FUNCTION retain_agent_repository_object();


-- Keep older writers/test fixtures compatible while a rolling deployment finishes.
-- Production application writes use R2 and never fall back to database content.
CREATE FUNCTION agent_workspace_blob_legacy_size() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
    IF NEW.content IS NOT NULL THEN NEW.size_bytes := octet_length(NEW.content); END IF;
    RETURN NEW;
END;
$function$;
CREATE TRIGGER agent_workspace_blob_legacy_size BEFORE INSERT OR UPDATE OF content ON agent_workspace_blobs
    FOR EACH ROW EXECUTE FUNCTION agent_workspace_blob_legacy_size();

INSERT INTO agent_workspace_blobs(workspace_id,sha256,content,size_bytes)
SELECT DISTINCT workspace_id,sha256,content,size_bytes FROM agent_workspace_files WHERE content IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION agent_workspace_storage_bytes(selected_user INTEGER)
RETURNS BIGINT LANGUAGE SQL STABLE AS $function$
    SELECT COALESCE((
        SELECT sum(COALESCE(octet_length(files.content), files.size_bytes))
        FROM agent_workspace_files files JOIN agent_workspaces workspace ON workspace.id = files.workspace_id
        WHERE workspace.user_id = selected_user AND workspace.deleted_at IS NULL
    ), 0) + COALESCE((
        SELECT sum(blobs.size_bytes)
        FROM agent_workspace_blobs blobs JOIN agent_workspaces workspace ON workspace.id = blobs.workspace_id
        WHERE workspace.user_id = selected_user AND workspace.deleted_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM agent_workspace_files files
            WHERE files.workspace_id = blobs.workspace_id AND files.sha256 = blobs.sha256
        )
    ), 0);
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
        SELECT refs.sha256, refs.last_revision, blobs.size_bytes AS bytes
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

CREATE OR REPLACE FUNCTION record_agent_workspace_commit(selected_id BIGINT, commit_action TEXT, restore_revision BIGINT DEFAULT NULL, commit_comment TEXT DEFAULT '')
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
    FROM agent_workspace_files WHERE workspace_id = selected_id AND content IS NOT NULL
    ON CONFLICT DO NOTHING;

    INSERT INTO agent_workspace_commits
        (workspace_id, revision, commit_id, parent_revision, action, restored_from, name, description, file_count, size_bytes, created_at, comment)
    SELECT selected_id, current_workspace.revision,
           encode(digest(convert_to(selected_id::text || ':' || current_workspace.revision::text, 'UTF8'), 'sha256'), 'hex'),
           (SELECT max(revision) FROM agent_workspace_commits WHERE workspace_id = selected_id),
           commit_action, restore_revision, current_workspace.name, current_workspace.description,
           count(*)::integer, COALESCE(sum(COALESCE(octet_length(content), size_bytes)), 0), current_workspace.updated_at, commit_comment
    FROM agent_workspace_files WHERE workspace_id = selected_id;

    INSERT INTO agent_workspace_commit_files (workspace_id, revision, path, mime_type, sha256, size_bytes)
    SELECT selected_id, current_workspace.revision, path, mime_type, CASE WHEN content IS NULL THEN sha256 ELSE encode(digest(content, 'sha256'), 'hex') END, COALESCE(octet_length(content), size_bytes)
    FROM agent_workspace_files WHERE workspace_id = selected_id;

    PERFORM prune_agent_workspace_history(selected_id, 100000000);
    SELECT agent_workspace_quota_bytes(current_workspace.user_id) INTO quota;
    PERFORM prune_agent_workspace_quota_history(selected_id, quota);
END;
$function$;
