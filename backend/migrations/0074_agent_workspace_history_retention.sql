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
          SELECT 1 FROM agent_workspace_files current_files
          WHERE current_files.workspace_id = blobs.workspace_id
            AND current_files.sha256 = blobs.sha256
      );
END;
$function$;

CREATE OR REPLACE FUNCTION prune_agent_workspace_history_after_commit()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
    PERFORM prune_agent_workspace_history(NEW.workspace_id, 100000000);
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS agent_workspace_history_retention ON agent_workspace_commits;
CREATE TRIGGER agent_workspace_history_retention
AFTER INSERT ON agent_workspace_commits
FOR EACH ROW EXECUTE FUNCTION prune_agent_workspace_history_after_commit();

DO $function$
DECLARE
    workspace RECORD;
BEGIN
    FOR workspace IN SELECT id FROM agent_workspaces LOOP
        PERFORM prune_agent_workspace_history(workspace.id, 100000000);
    END LOOP;
END;
$function$;
