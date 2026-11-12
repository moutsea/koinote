-- Correct reviewed automatic discoveries only. Preserve manual classification,
-- private copies, withdrawn/deleted entries, files, versions and publication time.
WITH categories(repository_url, category) AS (VALUES
    ('https://github.com/op7418/Humanizer-zh', 'writing'),
    ('https://github.com/conorbronsdon/avoid-ai-writing', 'writing'),
    ('https://github.com/Dodaios/ste80-humanizer', 'writing'),
    ('https://github.com/harshaneel/humanize', 'writing'),
    ('https://github.com/alchaincyf/x-mentor-skill', 'writing'),
    ('https://github.com/fcakyon/labrat', 'research'),
    ('https://github.com/dmoshehun-prog/learn-from-materials', 'research'),
    ('https://github.com/ai4s-research/ai4s-skills', 'research')
)
UPDATE agent_workspaces w SET hub_category=c.category
FROM categories c
WHERE w.is_system AND w.deleted_at IS NULL AND w.hub_category='agents'
  AND lower(w.github_source->>'repositoryUrl')=lower(c.repository_url)
  AND EXISTS(SELECT 1 FROM agent_repository_discoveries d WHERE d.workspace_id=w.id AND d.accepted_on IS NOT NULL)
  AND EXISTS(SELECT 1 FROM agent_repository_publications p WHERE p.workspace_id=w.id)
  AND NOT EXISTS(SELECT 1 FROM agent_repository_system_events e WHERE e.workspace_id=w.id AND e.actor_user_id IS NOT NULL);
