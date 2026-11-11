-- Count installed Skill payloads and versions still needed by active tasks.
-- This prepares quota accounting; task pinning and installation APIs are enabled
-- separately, after their authorization and lifecycle checks are in place.

CREATE TABLE agent_task_skill_versions (
    task_id uuid NOT NULL REFERENCES writing_agent_tasks(id) ON DELETE CASCADE,
    version_id uuid NOT NULL REFERENCES koi_skill_versions(id) ON DELETE RESTRICT,
    PRIMARY KEY (task_id,version_id)
);
CREATE INDEX agent_task_skill_versions_version ON agent_task_skill_versions(version_id);

CREATE OR REPLACE FUNCTION koi_skill_storage_bytes(selected_user INTEGER)
RETURNS BIGINT LANGUAGE SQL STABLE AS $function$
    SELECT COALESCE((
        SELECT sum(files.size_bytes)
        FROM koi_skill_version_files files
        JOIN koi_skill_versions versions ON versions.id = files.version_id
        WHERE versions.user_id = selected_user AND (
            EXISTS (SELECT 1 FROM koi_skill_installations installations
                    WHERE installations.current_version_id = versions.id AND installations.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM agent_task_skill_versions refs
                       JOIN writing_agent_tasks tasks ON tasks.id = refs.task_id
                       WHERE refs.version_id = versions.id
                         AND tasks.status NOT IN ('completed','failed','cancelled'))
        )
    ), 0);
$function$;
