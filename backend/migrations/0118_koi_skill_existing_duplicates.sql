-- Save upstream identity before a publication or private source is removed.
UPDATE koi_skill_installations i SET source=i.source || jsonb_build_object('repositoryId',p.github_source->'repositoryId')
FROM agent_repository_publications p
WHERE i.source_kind='hub' AND i.source->>'workspaceId'=p.workspace_id::text
  AND NOT (i.source ? 'repositoryId') AND p.github_source->>'repositoryId' ~ '^[1-9][0-9]*$';

UPDATE koi_skill_installations i SET source=i.source || jsonb_build_object('repositoryId',w.github_source->'repositoryId')
FROM agent_workspaces w
WHERE i.source_kind='migration' AND i.source->>'workspaceId'=w.id::text AND w.user_id=i.user_id
  AND NOT (i.source ? 'repositoryId') AND w.github_source->>'repositoryId' ~ '^[1-9][0-9]*$';

-- Collapse older client-adapter copies of the same source package. Preserve all
-- immutable versions and task references: running tasks keep their snapshots.
WITH remote AS (
    SELECT i.id,i.user_id,i.source_kind,v.content_sha256,i.enabled,i.created_at,
        CASE WHEN i.source_kind='github' THEN i.source->>'repositoryId'
             WHEN i.source_kind IN ('hub','migration') THEN i.source->>'workspaceId' END AS origin
    FROM koi_skill_installations i JOIN koi_skill_versions v ON v.id=i.current_version_id
    WHERE i.deleted_at IS NULL AND i.source_kind IN ('github','hub','migration')
), ranked AS (
    SELECT id,row_number() OVER (
        PARTITION BY user_id,source_kind,origin,content_sha256
        ORDER BY enabled DESC,created_at,id
    ) AS position FROM remote WHERE origin ~ '^[1-9][0-9]*$'
)
UPDATE koi_skill_installations i SET deleted_at=now(),enabled=false,
    revision=revision+1,updated_at=now()
FROM ranked WHERE ranked.id=i.id AND ranked.position>1;

-- Current packages and active-task snapshots share one logical quota charge
-- for identical bytes from the same origin, even before old pins expire.
-- Independent sources, unknown origins and different content remain separate.
CREATE OR REPLACE FUNCTION koi_skill_storage_bytes(selected_user INTEGER)
RETURNS BIGINT LANGUAGE SQL STABLE AS $function$
    WITH retained AS (
        SELECT v.id,v.content_sha256,i.source_kind,
            CASE WHEN i.source_kind='github' AND i.source->>'repositoryId' ~ '^[1-9][0-9]*$'
                 THEN i.source->>'repositoryId'
                 WHEN i.source_kind IN ('hub','migration') AND i.source->>'workspaceId' ~ '^[1-9][0-9]*$'
                 THEN i.source->>'workspaceId'
                 ELSE i.id::text END AS origin,
            (SELECT COALESCE(sum(f.size_bytes),0) FROM koi_skill_version_files f WHERE f.version_id=v.id) AS bytes
        FROM koi_skill_versions v JOIN koi_skill_installations i ON i.id=v.installation_id
        WHERE v.user_id=selected_user AND (
            (i.current_version_id=v.id AND i.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM agent_task_skill_versions refs
                       JOIN writing_agent_tasks tasks ON tasks.id=refs.task_id
                       WHERE refs.version_id=v.id AND tasks.status NOT IN ('completed','failed','cancelled'))
        )
    ), packages AS (
        SELECT max(bytes) AS bytes FROM retained GROUP BY source_kind,origin,content_sha256
    )
    SELECT COALESCE(sum(bytes),0)::bigint FROM packages;
$function$;
